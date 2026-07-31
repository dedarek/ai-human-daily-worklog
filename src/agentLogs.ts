import { open, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Activity, Settings } from "./types.js";
import { redact } from "./redact.js";

export { redact } from "./redact.js";

const home = homedir();

// 从各 agent 日志提取真实用户提问时，剔除系统注入内容（环境上下文、命令回显、工具结果、元消息）与低信号短语。
const STOP_PROMPTS = new Set(["继续", "ok", "好的", "嗯", "是的", "可以", "行", "对", "yes", "y", "go", "next", "对的", "嗯嗯"]);
const SYSTEM_PROMPT_NOISE = /<task-(?:notification|result)\b|<task-id\b|background agent .* was stopped by the user|<notification\b/i;
export function cleanPrompt(text: unknown): string {
  let source = String(text ?? "");
  const requestMarker = source.lastIndexOf("## My request for Codex:");
  if (requestMarker >= 0) source = source.slice(requestMarker + "## My request for Codex:".length);
  source = source.replace(/<(?:in-app-browser-context|environment_context|system-reminder)[^>]*>[\s\S]*?<\/(?:in-app-browser-context|environment_context|system-reminder)>/gi, " ");
  const raw = source.replace(/\s+/g, " ").trim();
  if (!raw || raw.length < 3) return "";
  if (SYSTEM_PROMPT_NOISE.test(raw)) return "";
  if (/^(command-name|local-command|environment_context|system-reminder)/i.test(raw)) return "";
  if (STOP_PROMPTS.has(raw.toLowerCase())) return "";
  return raw;
}

export function localDate(timestamp: string, timezone: string) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

async function jsonlFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try { entries = await readdir(dir, { withFileTypes: true }) as any; } catch { return; }
    for (const entry of entries as any[]) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  }
  await walk(root); return found;
}

async function recentJsonlFiles(root: string, cutoff: number, limit = 250) {
  const entries = await Promise.all((await jsonlFiles(root)).map(async path => ({ path, info: await stat(path).catch(() => null) })));
  return entries.filter(entry => entry.info && entry.info.mtimeMs >= cutoff).sort((a, b) => a.info!.mtimeMs - b.info!.mtimeMs).slice(-limit).map(entry => entry.path);
}

async function recentLines(path: string, maxBytes = 32 * 1024 * 1024) {
  const info = await stat(path); const start = Math.max(0, info.size - maxBytes);
  const handle = await open(path, "r"); const buffer = Buffer.alloc(info.size - start);
  try { await handle.read(buffer, 0, buffer.length, start); } finally { await handle.close(); }
  const lines = buffer.toString("utf8").split("\n"); if (start > 0) lines.shift();
  return lines;
}

function claudeDetail(name: string, input: any) {
  if (name === "Bash") return `执行命令：${input?.command ?? input?.description ?? "（未提供摘要）"}`;
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name)) return `${name} 文件：${input?.file_path ?? input?.path ?? "（未知路径）"}`;
  if (name === "Agent") return `启动子代理：${input?.description ?? input?.subagent_type ?? "未命名任务"}`;
  if (name.startsWith("Task")) return `${name}：${input?.subject ?? input?.status ?? input?.taskId ?? "任务操作"}`;
  if (name === "Skill") return `调用技能：${input?.skill ?? input?.name ?? "未命名技能"}`;
  return `调用工具 ${name}`;
}

async function claudeActivities(date: string, settings: Settings): Promise<Activity[]> {
  const activities: Activity[] = [];
  const usefulTools = new Set(["Bash", "Read", "Write", "Edit", "MultiEdit", "Agent", "TaskCreate", "Skill"]);
  const cutoff = Date.parse(`${date}T00:00:00Z`) - 24 * 3600 * 1000;
  for (const file of await recentJsonlFiles(join(home, ".claude", "projects"), cutoff)) {
    let lines: string[]; try { lines = await recentLines(file); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line); const timestamp = row.timestamp;
        if (!timestamp || localDate(timestamp, settings.timezone) !== date) continue;
        if (row.type === "user" && !row.isMeta && typeof row.message?.content === "string") {
          const prompt = cleanPrompt(row.message.content);
          if (prompt) activities.push({ timestamp, process: "Claude Code", message: `提问：${redact(prompt).slice(0, 400)}`, evidenceId: `claude-ask-${row.uuid ?? activities.length}` });
          continue;
        }
        if (row.type !== "assistant") continue;
        for (const item of Array.isArray(row.message?.content) ? row.message.content : []) {
          if (item?.type !== "tool_use" || !item.name || !usefulTools.has(item.name)) continue;
          activities.push({ timestamp, process: "Claude Code", message: redact(claudeDetail(item.name, item.input)).slice(0, 600), evidenceId: `claude-${item.id ?? activities.length}` });
        }
      } catch { /* ignore malformed lines */ }
    }
  }
  return activities;
}

function codexDetail(payload: any) {
  const name = payload.name ?? payload.type ?? "tool";
  let input: any = payload.input ?? payload.arguments ?? "";
  if (typeof input === "string") {
    const changedFiles = [...input.matchAll(/(?:Update|Add|Delete) File:\s*([^\n]+)/g)].map(match => match[1].trim());
    if (changedFiles.length) return `修改文件：${[...new Set(changedFiles)].join("、")}`;
    try { input = JSON.parse(input); } catch { return `${name}：${redact(input).slice(0, 420)}`; }
  }
  const detail = input?.cmd ?? input?.command ?? input?.path ?? input?.file ?? input?.url ?? input?.prompt ?? input?.query;
  return detail ? `${name}：${redact(String(detail)).slice(0, 420)}` : `调用工具 ${name}`;
}

async function codexActivities(date: string, settings: Settings): Promise<Activity[]> {
  const activities: Activity[] = [];
  // WHY 扫全部 rollout 而非当天目录：ChatGPT/Codex app 会在已有线程里继续对话，
  // 而 rollout 文件按线程「创建日」命名，今天的消息常被追加进旧日期文件。用 mtime 剪枝再逐行按 timestamp 过滤。
  const cutoff = Date.parse(`${date}T00:00:00Z`) - 24 * 3600 * 1000;
  for (const file of await recentJsonlFiles(join(home, ".codex", "sessions"), cutoff)) {
    let lines: string[]; try { lines = await recentLines(file); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line); const payload = row.payload ?? {};
        if (!row.timestamp || localDate(row.timestamp, settings.timezone) !== date || row.type !== "response_item") continue;
        if (payload.type === "message" && payload.role === "user") {
          const text = (Array.isArray(payload.content) ? payload.content : []).map((c: any) => c?.text ?? "").join(" ");
          const prompt = cleanPrompt(text);
          if (prompt) activities.push({ timestamp: row.timestamp, process: "Codex", message: `提问：${redact(prompt).slice(0, 400)}`, evidenceId: `codex-ask-${payload.id ?? activities.length}` });
          continue;
        }
        if (!["custom_tool_call", "function_call"].includes(payload.type)) continue;
        activities.push({ timestamp: row.timestamp, process: "Codex", message: codexDetail(payload).slice(0, 600), evidenceId: `codex-${payload.call_id ?? payload.id ?? activities.length}` });
      } catch { /* ignore malformed lines */ }
    }
  }
  return activities;
}

function opencodeDetail(data: any) {
  const input = data?.state?.input ?? {};
  const detail = input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.description;
  return detail ? `${data.tool ?? "工具"}：${redact(String(detail)).slice(0, 500)}` : `调用工具 ${data.tool ?? "未知"}`;
}

function opencodeActivities(date: string, settings: Settings): Activity[] {
  const dbPath = process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "opencode", "opencode.db")
    : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const out: Activity[] = [];
  const since = Date.parse(`${date}T00:00:00Z`) - 24 * 3600 * 1000;
  const iso = (value: number) => new Date(value).toISOString();
  try {
    const sessions = db.prepare("SELECT id, title, time_updated FROM session WHERE time_updated >= ? ORDER BY time_updated").all(since) as any[];
    for (const row of sessions) {
      const timestamp = iso(Number(row.time_updated));
      if (localDate(timestamp, settings.timezone) !== date) continue;
      const title = cleanPrompt(row.title);
      if (title) out.push({ timestamp, process: "OpenCode", message: `任务：${redact(title).slice(0, 400)}`, evidenceId: `opencode-session-${row.id}` });
    }
    const parts = db.prepare(
      "SELECT p.id, p.data, p.time_created, json_extract(m.data, '$.role') AS role " +
      "FROM part p JOIN message m ON p.message_id = m.id WHERE p.time_created >= ? ORDER BY p.time_created"
    ).all(since) as any[];
    for (const row of parts) {
      const timestamp = iso(Number(row.time_created));
      if (localDate(timestamp, settings.timezone) !== date) continue;
      let data: any; try { data = JSON.parse(row.data); } catch { continue; }
      if (row.role === "user" && data?.type === "text") {
        const prompt = cleanPrompt(data.text);
        if (prompt) out.push({ timestamp, process: "OpenCode", message: `提问：${redact(prompt).slice(0, 500)}`, evidenceId: `opencode-user-${row.id}` });
      } else if (data?.type === "tool" && ["bash", "edit", "write", "read", "glob", "grep"].includes(String(data.tool).toLowerCase())) {
        out.push({ timestamp, process: "OpenCode", message: opencodeDetail(data), evidenceId: `opencode-tool-${row.id}` });
      }
    }
  } catch { /* OpenCode schema can change; skip this source without blocking reports */ }
  finally { db.close(); }
  return out;
}

export async function collectAgentActivities(date: string, settings: Settings) {
  const [claude, codex] = await Promise.all([claudeActivities(date, settings), codexActivities(date, settings)]);
  const unique = new Map<string, Activity>();
  for (const item of [...claude, ...codex, ...opencodeActivities(date, settings)]) if (!unique.has(item.evidenceId)) unique.set(item.evidenceId, item);
  return [...unique.values()];
}
