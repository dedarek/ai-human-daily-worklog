import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { writeMeetingMinutes } from "./llm.js";
import { dataDir, getSecrets, getSettings, logRun } from "./store.js";
import { atomicWriteFile, createMutex, readJson, updateJson } from "./jsonStore.js";
import { hasMeetingSignal, isMeetingTitle, isMeetingWindow, transcriptQuality } from "./meetingDetect.js";
import { redact } from "./redact.js";
import { meetingTitle } from "./titles.js";
import type { MeetingRecord } from "./types.js";
import { worklogPlatform } from "./platform.js";

const exec = promisify(execFile);
const meetingsFile = join(dataDir, "meetings.json");
const nativeDetector = join(dataDir, "bin", "teams-audio-status");
const systemAudioCapture = join(dataDir, "bin", "system-audio-capture");
const capturePidFile = join(dataDir, "meetings", "capture.pid");
const processMeeting = createMutex();

type AudioStatus = {
  teamsProcessAudioRunning: boolean;
};

type RuntimeStatus = {
  supported: boolean;
  platform: string;
  monitoring: boolean;
  teamsInstalled: boolean;
  meetingWindowDetected: boolean;
  callActivityDetected: boolean;
  systemAudioCaptureAvailable: boolean;
  windowTitles: string[];
  current: MeetingRecord | null;
  lastError?: string;
};

let current: MeetingRecord | null = null;
let audioCapture: ChildProcess | null = null;
let captureClosed: Promise<number> | null = null;
let rawAudioPath = "";
let polling = false;
let monitorTimer: NodeJS.Timeout | undefined;
let startSignals = 0;
let missingMeetingWindows = 0;
let meetingWindowSeen = false;
let lastStatus: RuntimeStatus = {
  supported: worklogPlatform() === "macos",
  platform: worklogPlatform(),
  monitoring: false,
  teamsInstalled: false,
  meetingWindowDetected: false,
  callActivityDetected: false,
  systemAudioCaptureAvailable: false,
  windowTitles: [],
  current: null,
};

function localDate(iso: string, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function localTime(iso: string, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

async function loadMeetings(): Promise<MeetingRecord[]> {
  return readJson<MeetingRecord[]>(meetingsFile, []);
}

async function saveMeeting(record: MeetingRecord) {
  await updateJson<MeetingRecord[]>(meetingsFile, [], records => {
    const index = records.findIndex(item => item.id === record.id);
    if (index >= 0) records[index] = record; else records.push({ ...record });
    return records.slice(-100);
  });
}

async function audioStatus(): Promise<AudioStatus> {
  if (!existsSync(nativeDetector)) throw new Error("Teams 音频检测器尚未生成，请重新运行项目安装脚本。");
  const { stdout } = await exec(nativeDetector, [], { timeout: 5000 });
  return JSON.parse(stdout);
}

async function teamsWindowTitles() {
  const script = `tell application "System Events"
if not (exists process "MSTeams") then return ""
tell process "MSTeams" to return name of every window
end tell`;
  try {
    const { stdout } = await exec("/usr/bin/osascript", ["-e", script], { timeout: 5000 });
    return stdout.trim().split(/,\s*/).map(value => value.trim()).filter(Boolean);
  } catch { return []; }
}

async function teamsRunning() {
  try { await exec("/usr/bin/pgrep", ["-x", "MSTeams"], { timeout: 3000 }); return true; } catch { return false; }
}

function meetingSubject(titles: string[]) {
  const clean = (title: string) => title
    .replace(/\s*\|\s*Microsoft Teams\s*$/i, "")
    .replace(/^Meeting join\s*\|\s*/i, "")
    .replace(/\s*中的会议\s*$/u, "")
    .trim();
  const explicit = titles.find(isMeetingTitle);
  if (explicit) return clean(explicit);
  return titles.map(clean).find(title =>
    title &&
    !/^(聊天|活动|日历|通话记录|设置|chat|activity|calendar|history|settings)\s*\|/i.test(title) &&
    !/^Microsoft Teams$/i.test(title)
  );
}

async function startCapture(audioPath: string) {
  if (!existsSync(systemAudioCapture)) throw new Error("系统音频采集器尚未生成，请重新运行项目安装脚本。");
  const capture = spawn(systemAudioCapture, [], { stdio: ["ignore", "pipe", "pipe"] });
  rawAudioPath = `${audioPath}.pcm`;
  const output = createWriteStream(rawAudioPath, { mode: 0o600 });
  capture.stdout!.pipe(output);
  let captureError = "";
  capture.stderr!.on("data", chunk => captureError = (captureError + chunk).slice(-8000));
  captureClosed = new Promise((resolve, reject) => {
    capture.once("error", reject);
    capture.once("close", code => {
      void finished(output).then(() => code === null || code === 0 || code === 15 ? resolve(code ?? 0) : reject(new Error(captureError.trim() || `系统音频采集器退出码 ${code}`))).catch(reject);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      capture.once("error", error => { clearTimeout(timer); reject(error); });
      capture.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(captureError.trim() || `系统音频采集器未能启动（退出码 ${code}）`));
      });
    });
  } catch (error) {
    capture.kill("SIGKILL");
    captureClosed = null;
    throw error;
  }
  audioCapture = capture;
  if (capture.pid) await atomicWriteFile(capturePidFile, String(capture.pid));
}

export function wavHeader(dataBytes: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function finalizeWav(rawPath: string, audioPath: string) {
  const bytes = (await stat(rawPath)).size;
  await writeFile(audioPath, wavHeader(bytes), { mode: 0o600 });
  await pipeline(createReadStream(rawPath), createWriteStream(audioPath, { flags: "a" }));
  await rm(rawPath, { force: true });
}

export async function peakVolumeDb(audioPath: string) {
  let peak = 0;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of createReadStream(audioPath, { start: 44 })) {
    const incoming = chunk as Buffer;
    const data = pending.length ? Buffer.concat([pending, incoming]) : incoming;
    const usable = data.length - (data.length % 2);
    for (let index = 0; index < usable; index += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(index)));
    pending = usable < data.length ? data.subarray(usable) : Buffer.alloc(0);
  }
  return peak ? 20 * Math.log10(peak / 32768) : -Infinity;
}

function extractSection(report: string, heading: string) {
  const match = report.match(new RegExp(`## ${heading}\\s+([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim().replace(/^###\s+/gm, "").slice(0, 1600) || "";
}

async function appendMeetingActivities(record: MeetingRecord, report: string, timezone: string) {
  const date = localDate(record.startedAt, timezone);
  const dir = join(dataDir, "operations", date); await mkdir(dir, { recursive: true });
  const fields = [
    ["会议概览", extractSection(report, "会议概览")],
    ["讨论内容", extractSection(report, "讨论内容")],
    ["关键结论与决策", extractSection(report, "关键结论与决策")],
    ["待办事项", extractSection(report, "待办事项")],
  ].filter(([, value]) => value);
  const lines = fields.map(([label, value]) => JSON.stringify({
    timestamp: record.endedAt,
    process: "Teams Meeting",
    message: `${record.title}｜${label}：${value}`,
    evidenceId: `teams-${record.id}-${label}`,
  })).join("\n");
  if (lines) await appendFile(join(dir, "meetings.jsonl"), `${lines}\n`, { mode: 0o600 });
}

function safeMeetingError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replaceAll(dataDir, "[Worklog 数据目录]").slice(0, 500);
}

async function transcribeAndPublishUnlocked(record: MeetingRecord) {
  const settings = await getSettings(); const secrets = await getSecrets();
  const transcriptBase = record.transcriptPath!.replace(/\.txt$/, "");
  try {
    let transcript = record.transcriptPath && existsSync(record.transcriptPath)
      ? (await readFile(record.transcriptPath, "utf8")).trim()
      : "";
    if (!transcript) {
      if (!existsSync(settings.whisperCliPath)) throw new Error(`未找到本地转写程序：${settings.whisperCliPath}`);
      if (!existsSync(settings.whisperModelPath)) throw new Error(`未找到本地转写模型：${settings.whisperModelPath}`);
      const maxVolume = await peakVolumeDb(record.audioPath!);
      if (!Number.isFinite(maxVolume) || maxVolume <= -80) {
        record.status = "ignored";
        record.error = "系统音频全程静音，未纳入日报；会议期间没有捕获到电脑播放的声音。";
        await saveMeeting(record);
        await logRun({ status: "meeting_ignored", kind: "meeting", meetingId: record.id, title: record.title, reason: record.error });
        return;
      }
      const timeout = Math.min(12 * 3_600_000, Math.max(3_600_000, (record.durationSeconds || 1800) * 2000));
      await exec(settings.whisperCliPath, ["-m", settings.whisperModelPath, "-f", record.audioPath!, "-l", "auto", "-otxt", "-of", transcriptBase, "-nt", "-np"], { timeout, maxBuffer: 20 * 1024 * 1024 });
      transcript = (await readFile(record.transcriptPath!, "utf8")).trim();
    }
    const quality = transcriptQuality(transcript);
    if (!quality.valid) {
      record.status = "ignored";
      record.transcriptPreview = (settings.redactionEnabled ? redact(transcript, settings.redactionTerms) : transcript).slice(0, 240);
      record.error = `${quality.reason}，未纳入日报。`;
      await saveMeeting(record);
      await logRun({ status: "meeting_ignored", kind: "meeting", meetingId: record.id, title: record.title, reason: quality.reason });
      return;
    }
    const safeTranscript = settings.redactionEnabled ? redact(transcript, settings.redactionTerms) : transcript;
    record.status = "summarizing"; record.transcriptPreview = safeTranscript.slice(0, 240); await saveMeeting(record);
    const report = await writeMeetingMinutes(record.title, record.startedAt, record.endedAt!, safeTranscript, settings, secrets);
    if (/^无有效会议内容[。.!！]?$/u.test(report.trim()) || !extractSection(report, "会议概览")) {
      record.status = "ignored";
      record.error = "逐字稿无法支撑明确的工作内容，未纳入日报。";
      await saveMeeting(record);
      await logRun({ status: "meeting_ignored", kind: "meeting", meetingId: record.id, title: record.title, reason: record.error });
      return;
    }
    await writeFile(record.reportPath!, report, { mode: 0o600 });
    await appendMeetingActivities(record, report, settings.timezone);
    Object.assign(record, { status: "included", summaryPreview: extractSection(report, "会议概览").slice(0, 300) });
    delete record.documentId;
    delete record.url;
    await saveMeeting(record);
    await logRun({ status: "meeting_included", kind: "meeting", meetingId: record.id, title: record.title, startedAt: record.startedAt, endedAt: record.endedAt });
  } catch (error) {
    const message = safeMeetingError(error);
    record.status = "failed"; record.error = message; await saveMeeting(record);
    await logRun({ status: "failed", kind: "meeting", meetingId: record.id, title: record.title, error: message });
  }
}

const transcribeAndPublish = (record: MeetingRecord) => processMeeting(() => transcribeAndPublishUnlocked(record));

export async function retryTeamsMeeting(id: string) {
  if (current?.id === id) throw new Error("该会议仍在录制，请结束后再重试。");
  const record = (await loadMeetings()).find(item => item.id === id);
  if (!record) throw new Error("未找到该会议记录。");
  if (!record.endedAt || (!record.audioPath || !existsSync(record.audioPath)) && (!record.transcriptPath || !existsSync(record.transcriptPath))) throw new Error("该会议没有可复用的音频或逐字稿，无法重试。");
  if (!record.transcriptPath && record.audioPath) record.transcriptPath = join(dirname(record.audioPath), "transcript.txt");
  if (!record.reportPath && record.audioPath) record.reportPath = join(dirname(record.audioPath), "minutes.md");
  record.status = record.transcriptPath && existsSync(record.transcriptPath) && (await readFile(record.transcriptPath, "utf8")).trim() ? "summarizing" : "transcribing";
  delete record.error;
  await saveMeeting(record);
  await transcribeAndPublish(record);
  return record;
}

export async function startTeamsMeeting(origin: "automatic" | "manual" = "manual", requestedTitle?: string) {
  if (worklogPlatform() !== "macos") throw new Error("Teams 系统音频记录目前仅支持 macOS；Windows/Linux 版本仍会记录 Agent、终端与前台应用活动。");
  if (current) throw new Error("已有一场 Teams 会议正在记录。");
  const settings = await getSettings(); const startedAt = new Date().toISOString();
  if (settings.capturePaused) throw new Error("采集已暂停，请先在 Worklog 页面恢复采集。");
  const id = `${localDate(startedAt, settings.timezone)}-${startedAt.slice(11, 19).replace(/:/g, "")}-${randomUUID().slice(0, 6)}`;
  const dir = join(dataDir, "meetings", id); await mkdir(dir, { recursive: true });
  const title = meetingTitle(localDate(startedAt, settings.timezone), localTime(startedAt, settings.timezone), requestedTitle);
  const record: MeetingRecord = {
    id, provider: "Microsoft Teams", title, status: "recording", startedAt, origin,
    audioPath: join(dir, "audio.wav"), transcriptPath: join(dir, "transcript.txt"), reportPath: join(dir, "minutes.md"),
  };
  current = record; meetingWindowSeen = false; missingMeetingWindows = 0;
  try { await startCapture(record.audioPath!); await saveMeeting(record); await logRun({ status: "meeting_recording", meetingId: id, title, origin }); }
  catch (error) { current = null; record.status = "failed"; record.error = String(error); await saveMeeting(record); throw error; }
  return record;
}

export async function stopTeamsMeeting() {
  if (!current || !audioCapture || !captureClosed) throw new Error("当前没有正在记录的 Teams 会议。");
  const record = current; record.endedAt = new Date().toISOString();
  record.durationSeconds = Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000));
  record.status = "transcribing"; await saveMeeting(record);
  audioCapture.kill("SIGTERM");
  const forceKill = setTimeout(() => audioCapture?.kill("SIGKILL"), 8000);
  try { await captureClosed; await finalizeWav(rawAudioPath, record.audioPath!); }
  finally { audioCapture = null; captureClosed = null; rawAudioPath = ""; current = null; await unlink(capturePidFile).catch(() => {}); }
  clearTimeout(forceKill);
  void transcribeAndPublish(record);
  return record;
}

async function poll() {
  if (polling) return; polling = true;
  try {
    const settings = await getSettings();
    const [audio, titles, running] = await Promise.all([audioStatus(), teamsWindowTitles(), teamsRunning()]);
    const meetingWindowDetected = isMeetingWindow(titles);
    const signals = { teamsCallActive: audio.teamsProcessAudioRunning, meetingWindow: meetingWindowDetected };
    const meetingSignal = running && hasMeetingSignal(signals);
    lastStatus = {
      supported: true,
      platform: "macos",
      monitoring: settings.teamsMeetingEnabled,
      teamsInstalled: running,
      meetingWindowDetected,
      callActivityDetected: audio.teamsProcessAudioRunning,
      systemAudioCaptureAvailable: existsSync(systemAudioCapture),
      windowTitles: titles,
      current,
    };
    if (settings.capturePaused || !settings.teamsMeetingEnabled || !settings.teamsAutoRecord) { startSignals = 0; return; }
    if (!current) {
      startSignals = meetingSignal ? startSignals + 1 : 0;
      if (startSignals >= 2) {
        startSignals = 0;
        await startTeamsMeeting("automatic", meetingSubject(titles));
        meetingWindowSeen = true;
      }
      return;
    }
    if (meetingSignal) { meetingWindowSeen = true; missingMeetingWindows = 0; }
    else if (meetingWindowSeen) missingMeetingWindows += 1;
    const recordingSeconds = (Date.now() - Date.parse(current.startedAt)) / 1000;
    // Teams 进程的音频 I/O 是主信号，窗口仅为入会阶段兜底。
    // 两者连续一分钟都消失才停止，容忍短暂设备切换。
    if (!running || (meetingWindowSeen && missingMeetingWindows >= 12) || recordingSeconds >= 6 * 60 * 60) await stopTeamsMeeting();
  } catch (error) { lastStatus = { ...lastStatus, current, lastError: String(error) }; }
  finally { polling = false; }
}

// 启动时清理进程重启遗留的非终态会议：录音无法恢复直接标记失败；
// 转写/整理阶段若音频仍在则续跑，否则标记失败，避免记录永久卡住。
export async function recoverMeetings() {
  if (worklogPlatform() !== "macos") return;
  // 只清理 Worklog 自己记录的精确 PID，并核对命令路径，避免 pkill 模式误伤无关进程。
  try {
    const pid = Number((await readFile(capturePidFile, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 1) {
      const command = (await exec("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 })).stdout;
      if (command.includes(systemAudioCapture)) process.kill(pid, "SIGKILL");
    }
  } catch { /* no stale owned capture */ }
  await unlink(capturePidFile).catch(() => {});
  const records = await loadMeetings();
  for (const record of records) {
    if (record.status === "recording") {
      record.status = "failed";
      record.error = "服务重启导致录音中断，无法恢复该会议。";
      if (!record.endedAt) record.endedAt = new Date().toISOString();
      await saveMeeting(record);
    } else if (record.status === "transcribing" || record.status === "summarizing") {
      if (record.audioPath && existsSync(record.audioPath) && record.endedAt) {
        record.status = "transcribing"; await saveMeeting(record);
        void transcribeAndPublish(record);
      } else {
        record.status = "failed";
        record.error = "服务重启导致转写中断，且缺少可用录音，无法恢复。";
        await saveMeeting(record);
      }
    }
  }
}

export async function startTeamsMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  if (worklogPlatform() !== "macos") {
    lastStatus = { ...lastStatus, supported: false, platform: worklogPlatform(), monitoring: false, lastError: "当前平台暂不支持 Teams 系统音频采集。" };
    return;
  }
  lastStatus.monitoring = true;
  await recoverMeetings().catch(error => void logRun({ status: "failed", kind: "meeting", error: `恢复历史会议失败：${safeMeetingError(error)}` }));
  monitorTimer = setInterval(() => void poll(), 5000);
  void poll();
}

export async function stopTeamsMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = undefined;
  lastStatus.monitoring = false;
  if (current && audioCapture && captureClosed) await stopTeamsMeeting();
}

export function getTeamsMeetingStatus() {
  return { ...lastStatus, current };
}

export async function listTeamsMeetings() {
  return (await loadMeetings()).slice(-20).reverse();
}
