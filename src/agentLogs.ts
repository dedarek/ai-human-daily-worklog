import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Activity, Settings } from "./types.js";

const home = process.env.HOME || "/Users/mac";

const redact = (text: string) => text
  .replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
  .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*)[^\s;,}]+/gi, "$1[REDACTED]")
  .replace(/(--(?:api[_-]?key|token|secret|password)(?:=|\s+))[^\s]+/gi, "$1[REDACTED]");

function localDate(timestamp: string, timezone: string) {
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
        if (!timestamp || localDate(timestamp, settings.timezone) !== date || row.type !== "assistant") continue;
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
  const [year, month, day] = date.split("-");
  for (const file of await jsonlFiles(join(home, ".codex", "sessions", year, month, day))) {
    let lines: string[]; try { lines = (await readFile(file, "utf8")).split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line); const payload = row.payload ?? {};
        if (!row.timestamp || localDate(row.timestamp, settings.timezone) !== date || row.type !== "response_item") continue;
        if (!["custom_tool_call", "function_call"].includes(payload.type)) continue;
        activities.push({ timestamp: row.timestamp, process: "Codex", message: codexDetail(payload).slice(0, 600), evidenceId: `codex-${payload.call_id ?? payload.id ?? activities.length}` });
      } catch { /* ignore malformed lines */ }
    }
  }
  return activities;
}

export async function collectAgentActivities(date: string, settings: Settings) {
  const [claude, codex] = await Promise.all([claudeActivities(date, settings), codexActivities(date, settings)]);
  const unique = new Map<string, Activity>();
  for (const item of [...claude, ...codex]) if (!unique.has(item.evidenceId)) unique.set(item.evidenceId, item);
  return [...unique.values()];
}
