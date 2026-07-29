import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Activity, Settings } from "./types.js";
import { redact } from "./redact.js";

export { redact } from "./redact.js";

const home = process.env.HOME || "/Users/mac";

// 从各 agent 日志提取真实用户提问时，剔除系统注入内容（环境上下文、命令回显、工具结果、元消息）与低信号短语。
const STOP_PROMPTS = new Set(["继续", "ok", "好的", "嗯", "是的", "可以", "行", "对", "yes", "y", "go", "next", "对的", "嗯嗯"]);
export function cleanPrompt(text: unknown): string {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length < 3) return "";
  if (raw.startsWith("<") || raw.startsWith("[")) return "";
  // WHY：ChatGPT/Codex app 常把上一轮助手输出/上下文回显塞进 user turn，这类以 markdown 列表/强调符开头，非用户真实提问。
  if (/^[•*#>]/.test(raw) || /^[-–—]\s/.test(raw)) return "";
  if (/^#\s*(Files|环境|Caveat)/i.test(raw)) return "";
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
  for (const file of await jsonlFiles(join(home, ".claude", "projects"))) {
    let lines: string[]; try { lines = (await readFile(file, "utf8")).split("\n"); } catch { continue; }
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
  for (const file of await jsonlFiles(join(home, ".codex", "sessions"))) {
    try { if ((await stat(file)).mtimeMs < cutoff) continue; } catch { continue; }
    let lines: string[]; try { lines = (await readFile(file, "utf8")).split("\n"); } catch { continue; }
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
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
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
