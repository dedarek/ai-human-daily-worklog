import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, sha256 } from "./store.js";
import type { Activity, Operation, Settings } from "./types.js";
import { collectAgentActivities } from "./agentLogs.js";
import { collectAppHistory } from "./appHistory.js";
import { inHourWindow } from "./time.js";
export async function collect(date: string, settings: Settings, window = { startHour: 8, endHour: 18 }) {
  const input = join(dataDir, "operations", date, "frontmost.jsonl");
  const terminalInput = join(dataDir, "operations", date, "terminal.jsonl");
  const meetingInput = join(dataDir, "operations", date, "meetings.jsonl");
  let rows: Operation[] = [];
  try { rows = (await readFile(input, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { /* no samples recorded */ }
  const seen = new Set<string>();
  const activities: Activity[] = rows.filter(row => inHourWindow(row.timestamp, settings.timezone, window.startHour, window.endHour)).filter(row => !settings.ignoredProcesses.includes(row.app)).filter(row => {
    const key = `${row.app}|${row.windowTitle}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).map(row => ({ timestamp: row.timestamp, process: row.app, message: row.windowTitle ? `前台窗口：${row.windowTitle}` : "前台应用处于活跃状态", evidenceId: row.evidenceId }));
  try {
    const commands = (await readFile(terminalInput, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { timestamp: string; cwd: string; command: string; evidenceId: string });
    activities.push(...commands.filter(command => inHourWindow(command.timestamp, settings.timezone, window.startHour, window.endHour)).map(command => ({ timestamp: command.timestamp, process: "Terminal", message: `命令：${command.command}${command.cwd ? `（目录：${command.cwd}）` : ""}`, evidenceId: command.evidenceId })));
  } catch { /* no terminal commands recorded */ }
  try {
    const meetings = (await readFile(meetingInput, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Activity);
    activities.push(...meetings.filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)));
  } catch { /* no Teams meetings recorded */ }
  activities.push(...(await collectAgentActivities(date, settings)).filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)));
  activities.push(...collectAppHistory(date, settings).filter(item => inHourWindow(item.timestamp, settings.timezone, window.startHour, window.endHour)));
  activities.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const raw = activities.map(x => JSON.stringify(x)).join("\n") + (activities.length ? "\n" : "");
  const dir = join(dataDir, "evidence", date); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "activity.jsonl"), raw, { mode: 0o600 });
  const manifest = { date, generatedAt: new Date().toISOString(), source: "frontmost-app-and-window-sampler", window: `${String(window.startHour).padStart(2, "0")}:00-${String(window.endHour).padStart(2, "0")}:00`, eventCount: activities.length, sha256: sha256(raw), processes: [...new Set(activities.map(x => x.process))] };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { activities, manifest };
}
