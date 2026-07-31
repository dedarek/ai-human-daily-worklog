import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, sha256 } from "./store.js";
import type { Activity, Operation, Settings } from "./types.js";
import { collectAgentActivities } from "./agentLogs.js";
import { collectAppHistory } from "./appHistory.js";
import { inHourWindow } from "./time.js";
import { redact } from "./redact.js";
import { atomicWriteFile, readJson } from "./jsonStore.js";

const safe = (value: string, settings: Settings) => settings.redactionEnabled ? redact(value, settings.redactionTerms) : value;
const evidenceDir = (date: string) => join(dataDir, "evidence", date);

function sanitizeActivities(activities: Activity[], settings: Settings) {
  return activities.map(item => ({ ...item, process: safe(item.process, settings), message: safe(item.message, settings) }));
}

async function saveEvidence(date: string, activities: Activity[], window: { startHour: number; endHour: number }) {
  const raw = activities.map(x => JSON.stringify(x)).join("\n") + (activities.length ? "\n" : "");
  const dir = evidenceDir(date); await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, "activity.jsonl"), raw);
  const manifest = { date, generatedAt: new Date().toISOString(), source: "frontmost-app-and-window-sampler", window: `${String(window.startHour).padStart(2, "0")}:00-${String(window.endHour).padStart(2, "0")}:00`, eventCount: activities.length, sha256: sha256(raw), processes: [...new Set(activities.map(x => x.process))] };
  await atomicWriteFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function readAudit(date: string, settings: Settings, window = { startHour: 8, endHour: 18 }) {
  const input = join(evidenceDir(date), "activity.jsonl");
  if (!existsSync(input)) return collect(date, settings, window);
  try {
    if ((await stat(input)).mtimeMs < Date.now() - 5 * 60_000) return collect(date, settings, window);
    const activities = sanitizeActivities((await readFile(input, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Activity), settings);
    const manifest = await readJson(join(evidenceDir(date), "manifest.json"), { date, generatedAt: new Date((await stat(input)).mtimeMs).toISOString(), source: "cached-evidence", window: `${window.startHour}:00-${window.endHour}:00`, eventCount: activities.length, processes: [...new Set(activities.map(item => item.process))] });
    return { activities, manifest };
  } catch (error) {
    throw new Error(`证据缓存已损坏，已停止自动覆盖：${input}`, { cause: error });
  }
}

export async function collect(date: string, settings: Settings, window = { startHour: 8, endHour: 18 }) {
  const input = join(dataDir, "operations", date, "frontmost.jsonl");
  const terminalInput = join(dataDir, "operations", date, "terminal.jsonl");
  const meetingInput = join(dataDir, "operations", date, "meetings.jsonl");
  let rows: Operation[] = [];
  try { rows = (await readFile(input, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* no samples recorded */ }
  const foreground = new Map<string, { first: Operation; last: Operation; samples: number }>();
  for (const row of rows.filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)).filter(item => !settings.ignoredProcesses.includes(item.app))) {
    const key = `${row.app}|${row.windowTitle}`; const existing = foreground.get(key);
    if (existing) { existing.last = row; existing.samples++; } else foreground.set(key, { first: row, last: row, samples: 1 });
  }
  const clock = (timestamp: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
  const activities: Activity[] = [...foreground.values()].map(({ first, last, samples }) => ({
    timestamp: first.timestamp,
    process: safe(first.app, settings),
    message: `${first.windowTitle ? `前台窗口：${safe(first.windowTitle, settings)}` : "前台应用处于活跃状态"}（${clock(first.timestamp)}–${clock(last.timestamp)}，采样 ${samples} 次）`,
    evidenceId: first.evidenceId,
  }));
  try {
    const commands = (await readFile(terminalInput, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { timestamp: string; cwd: string; command: string; evidenceId: string });
    activities.push(...commands.filter(command => inHourWindow(command.timestamp, settings.timezone, window.startHour, window.endHour)).map(command => ({ timestamp: command.timestamp, process: "Terminal", message: `命令：${safe(command.command, settings)}${command.cwd ? `（目录：${safe(command.cwd, settings)}）` : ""}`, evidenceId: command.evidenceId })));
  } catch { /* no terminal commands recorded */ }
  try {
    const meetings = (await readFile(meetingInput, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Activity);
    activities.push(...meetings.filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)).map(item => ({ ...item, process: safe(item.process, settings), message: safe(item.message, settings) })));
  } catch { /* no Teams meetings recorded */ }
  activities.push(...(await collectAgentActivities(date, settings)).filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)).map(item => ({ ...item, process: safe(item.process, settings), message: safe(item.message, settings) })));
  activities.push(...collectAppHistory(date, settings).filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)).map(item => ({ ...item, process: safe(item.process, settings), message: safe(item.message, settings) })));
  activities.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const manifest = await saveEvidence(date, activities, window);
  return { activities, manifest };
}
