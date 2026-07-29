import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeMeetingMinutes } from "./llm.js";
import { dataDir, getSecrets, getSettings, logRun } from "./store.js";
import { readJson, updateJson } from "./jsonStore.js";
import { hasMeetingSignal, isMeetingTitle, isMeetingWindow, transcriptQuality } from "./meetingDetect.js";
import { redact } from "./redact.js";
import { meetingTitle } from "./titles.js";
import type { MeetingRecord, Settings } from "./types.js";

const exec = promisify(execFile);
const meetingsFile = join(dataDir, "meetings.json");
const nativeDetector = join(dataDir, "bin", "teams-audio-status");
const systemAudioCapture = join(dataDir, "bin", "system-audio-capture");
const ffmpegCandidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

type AudioStatus = {
  teamsProcessAudioRunning: boolean;
};

type RuntimeStatus = {
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
let recorder: ChildProcessWithoutNullStreams | null = null;
let audioCapture: ChildProcess | null = null;
let recorderClosed: Promise<number> | null = null;
let polling = false;
let monitorTimer: NodeJS.Timeout | undefined;
let startSignals = 0;
let missingMeetingWindows = 0;
let meetingWindowSeen = false;
let lastStatus: RuntimeStatus = {
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

function ffmpegPath() {
  const found = ffmpegCandidates.find(path => existsSync(path));
  if (!found) throw new Error("未找到 FFmpeg，无法录制 Teams 会议音频。");
  return found;
}

async function startCapture(audioPath: string) {
  if (!existsSync(systemAudioCapture)) throw new Error("系统音频采集器尚未生成，请重新运行项目安装脚本。");
  const capture = spawn(systemAudioCapture, [], { stdio: ["ignore", "pipe", "pipe"] });
  const args = ["-hide_banner", "-loglevel", "warning", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-c:a", "pcm_s16le", "-y", audioPath];
  const child = spawn(ffmpegPath(), args, { stdio: ["pipe", "pipe", "pipe"] });
  capture.stdout?.pipe(child.stdin);
  let stderr = "", captureError = "";
  child.stderr.on("data", chunk => stderr = (stderr + chunk).slice(-8000));
  capture.stderr?.on("data", chunk => captureError = (captureError + chunk).slice(-8000));
  recorderClosed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === null || code === 0 || code === 255 ? resolve(code ?? 0) : reject(new Error(stderr.trim() || `FFmpeg 退出码 ${code}`)));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1500);
      capture.once("error", error => { clearTimeout(timer); reject(error); });
      capture.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(captureError.trim() || `系统音频采集器未能启动（退出码 ${code}）`));
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(stderr.trim() || `录音未能启动（退出码 ${code}）`)); });
    });
  } catch (error) {
    capture.kill("SIGKILL");
    child.kill("SIGKILL");
    recorderClosed = null;
    throw error;
  }
  audioCapture = capture;
  recorder = child;
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

async function transcribeAndPublish(record: MeetingRecord) {
  const settings = await getSettings(); const secrets = await getSecrets();
  const transcriptBase = record.transcriptPath!.replace(/\.txt$/, "");
  try {
    let transcript = record.transcriptPath && existsSync(record.transcriptPath)
      ? (await readFile(record.transcriptPath, "utf8")).trim()
      : "";
    if (!transcript) {
      if (!existsSync(settings.whisperCliPath)) throw new Error(`未找到本地转写程序：${settings.whisperCliPath}`);
      if (!existsSync(settings.whisperModelPath)) throw new Error(`未找到本地转写模型：${settings.whisperModelPath}`);
      const { stderr: volumeLog } = await exec(ffmpegPath(), ["-hide_banner", "-i", record.audioPath!, "-af", "volumedetect", "-f", "null", "-"], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
      const maxVolume = Number(volumeLog.match(/max_volume:\s*(-?[\d.]+)\s*dB/i)?.[1] ?? "-Infinity");
      if (!Number.isFinite(maxVolume) || maxVolume <= -80) {
        record.status = "ignored";
        record.error = "系统音频全程静音，未纳入日报；会议期间没有捕获到电脑播放的声音。";
        await saveMeeting(record);
        await logRun({ status: "meeting_ignored", kind: "meeting", meetingId: record.id, title: record.title, reason: record.error });
        return;
      }
      await exec(settings.whisperCliPath, ["-m", settings.whisperModelPath, "-f", record.audioPath!, "-l", "auto", "-otxt", "-of", transcriptBase, "-nt", "-np"], { timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      transcript = (await readFile(record.transcriptPath!, "utf8")).trim();
    }
    const quality = transcriptQuality(transcript);
    if (!quality.valid) {
      record.status = "ignored";
      record.transcriptPreview = transcript.slice(0, 240);
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
    record.status = "failed"; record.error = String(error); await saveMeeting(record);
    await logRun({ status: "failed", kind: "meeting", meetingId: record.id, title: record.title, error: String(error) });
  }
}

export async function retryTeamsMeeting(id: string) {
  if (current?.id === id) throw new Error("该会议仍在录制，请结束后再重试。");
  const record = (await loadMeetings()).find(item => item.id === id);
  if (!record) throw new Error("未找到该会议记录。");
  if (!record.endedAt || !record.transcriptPath || !existsSync(record.transcriptPath)) {
    throw new Error("该会议没有可复用的逐字稿，无法重试整理。");
  }
  if (!(await readFile(record.transcriptPath, "utf8")).trim()) {
    throw new Error("该会议的逐字稿为空，无法重试整理。");
  }
  record.status = "summarizing";
  delete record.error;
  await saveMeeting(record);
  await transcribeAndPublish(record);
  return record;
}

export async function startTeamsMeeting(origin: "automatic" | "manual" = "manual", requestedTitle?: string) {
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
  if (!current || !recorder || !recorderClosed) throw new Error("当前没有正在记录的 Teams 会议。");
  const record = current; record.endedAt = new Date().toISOString();
  record.durationSeconds = Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000));
  record.status = "transcribing"; await saveMeeting(record);
  audioCapture?.kill("SIGTERM");
  const terminate = setTimeout(() => recorder?.kill("SIGTERM"), 3000);
  const forceKill = setTimeout(() => recorder?.kill("SIGKILL"), 8000);
  try { await recorderClosed; } finally { audioCapture = null; recorder = null; recorderClosed = null; current = null; }
  clearTimeout(terminate); clearTimeout(forceKill);
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
  // 服务异常退出时清理遗留的系统音频与 WAV 封装进程。
  try { await exec("/usr/bin/pkill", ["-KILL", "-f", systemAudioCapture], { timeout: 3000 }); } catch { /* no stale capture */ }
  try { await exec("/usr/bin/pkill", ["-KILL", "-f", `${dataDir}/meetings/.*/audio\\.wav`], { timeout: 3000 }); } catch { /* no stale recorder */ }
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

export function startTeamsMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  lastStatus.monitoring = true;
  void recoverMeetings().catch(error => void logRun({ status: "failed", kind: "meeting", error: `恢复历史会议失败：${String(error)}` }));
  monitorTimer = setInterval(() => void poll(), 5000);
  void poll();
}

export function getTeamsMeetingStatus() {
  return { ...lastStatus, current };
}

export async function listTeamsMeetings() {
  return (await loadMeetings()).slice(-20).reverse();
}
