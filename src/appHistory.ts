// 从本机 App 的 SQLite 会话库读取当日对话/工作历史，作为日报留痕来源。
// Copilot：~/.copilot/session-store.db 的 turns（用户提问）。
// ZCode：  ~/.zcode/cli/db/db.sqlite 的 session（任务标题）与 part（对话文本、工具调用）。
// WHY 只读打开：这些库被对应 App 以 WAL 模式并发写入，只读避免锁冲突与误改。
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Activity, Settings } from "./types.js";
import { redact, cleanPrompt, localDate } from "./agentLogs.js";

const home = process.env.HOME || "/Users/mac";

function openReadonly(path: string): InstanceType<typeof DatabaseSync> | null {
  if (!existsSync(path)) return null;
  try { return new DatabaseSync(path, { readOnly: true }); } catch { return null; }
}

// 粗下界：目标日期前一天的 UTC 零点（毫秒），缩小扫描量；逐行仍按时区精确过滤。
function sinceMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - 24 * 3600 * 1000;
}

function copilotActivities(date: string, settings: Settings): Activity[] {
  const db = openReadonly(join(home, ".copilot", "session-store.db"));
  if (!db) return [];
  const out: Activity[] = [];
  try {
    const rows = db.prepare("SELECT id, user_message, timestamp FROM turns WHERE user_message IS NOT NULL ORDER BY timestamp").all() as any[];
    for (const row of rows) {
      const timestamp = String(row.timestamp ?? "");
      if (!timestamp || localDate(timestamp, settings.timezone) !== date) continue;
      const prompt = cleanPrompt(row.user_message);
      if (!prompt) continue;
      out.push({ timestamp, process: "Copilot", message: `提问：${redact(prompt).slice(0, 400)}`, evidenceId: `copilot-${row.id}` });
    }
  } catch { /* schema 变动或库损坏时忽略 */ } finally { db.close(); }
  return out;
}

function zcodeActivities(date: string, settings: Settings): Activity[] {
  const db = openReadonly(join(home, ".zcode", "cli", "db", "db.sqlite"));
  if (!db) return [];
  const out: Activity[] = [];
  const since = sinceMs(date);
  const iso = (ms: number) => new Date(ms).toISOString();
  try {
    const sessions = db.prepare("SELECT id, title, time_updated FROM session WHERE time_updated >= ? ORDER BY time_updated").all(since) as any[];
    for (const row of sessions) {
      const ts = iso(Number(row.time_updated));
      if (localDate(ts, settings.timezone) !== date) continue;
      const title = cleanPrompt(row.title);
      if (title) out.push({ timestamp: ts, process: "ZCode", message: `任务：${redact(title).slice(0, 300)}`, evidenceId: `zcode-s-${row.id}` });
    }
    // WHY join message：part 本身不带 role，只保留用户角色文本（真实意图），丢弃助手寒暄与工具洪流。
    const parts = db.prepare(
      "SELECT p.id, p.data, p.time_created FROM part p JOIN message m ON p.message_id = m.id " +
      "WHERE p.time_created >= ? AND json_extract(m.data, '$.role') = 'user' ORDER BY p.time_created"
    ).all(since) as any[];
    for (const row of parts) {
      const ts = iso(Number(row.time_created));
      if (localDate(ts, settings.timezone) !== date) continue;
      let data: any; try { data = JSON.parse(row.data); } catch { continue; }
      if (data?.type !== "text") continue;
      const text = cleanPrompt(data.text);
      if (text) out.push({ timestamp: ts, process: "ZCode", message: `提问：${redact(text).slice(0, 400)}`, evidenceId: `zcode-t-${row.id}` });
    }
  } catch { /* schema 变动或库损坏时忽略 */ } finally { db.close(); }
  return out;
}

export function collectAppHistory(date: string, settings: Settings): Activity[] {
  const unique = new Map<string, Activity>();
  for (const item of [...copilotActivities(date, settings), ...zcodeActivities(date, settings)]) {
    if (!unique.has(item.evidenceId)) unique.set(item.evidenceId, item);
  }
  return [...unique.values()];
}
