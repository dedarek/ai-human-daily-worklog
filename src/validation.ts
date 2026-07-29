import cron from "node-cron";
import type { Settings } from "./types.js";

export function validDate(value: unknown, fallback?: string) {
  const date = String(value ?? fallback ?? "");
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("日期格式应为 YYYY-MM-DD。");
  return date;
}

export function validId(value: unknown, label = "标识") {
  const id = String(value ?? "");
  if (!/^[\p{L}\p{N}_.:-]{1,120}$/u.test(id)) throw new Error(`${label}无效。`);
  return id;
}

function validTimezone(value: unknown) {
  const timezone = String(value ?? "").trim();
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw new Error(`时区无效：${timezone}`); }
  return timezone;
}

function validEndpoint(value: unknown) {
  const text = String(value ?? "").trim().replace(/\/$/, "");
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("LLM API 地址无效。"); }
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("LLM API 必须使用 HTTPS；仅本机地址允许 HTTP。");
  return text;
}

function stringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.map(item => String(item).trim()).filter(Boolean).slice(0, 200);
}

export function validateSchedules(settings: Pick<Settings, "schedule" | "weeklySchedule" | "monthlySchedule" | "morningSchedule">) {
  for (const [name, expression] of [["日报", settings.schedule], ["周报", settings.weeklySchedule], ["月报", settings.monthlySchedule], ["晨间续接", settings.morningSchedule]] as const) {
    if (!cron.validate(expression)) throw new Error(`${name}定时规则无效：${expression}`);
  }
}

export function settingsFromInput(old: Settings, input: unknown): Settings {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const string = (key: keyof Settings, fallback = String(old[key] ?? "")) => typeof body[key] === "string" ? body[key].trim() : fallback;
  const bool = (key: keyof Settings) => typeof body[key] === "boolean" ? body[key] : Boolean(old[key]);
  const integer = (key: keyof Settings, fallback: number, min: number, max: number) => {
    const value = Number(body[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${String(key)} 超出允许范围。`);
    return value;
  };
  const next: Settings = {
    ...old,
    schedule: string("schedule"), weeklySchedule: string("weeklySchedule"), monthlySchedule: string("monthlySchedule"), morningSchedule: string("morningSchedule"),
    timezone: validTimezone(body.timezone ?? old.timezone),
    ignoredProcesses: stringList(body.ignoredProcesses, old.ignoredProcesses),
    capturePaused: bool("capturePaused"), redactionEnabled: bool("redactionEnabled"), redactionTerms: stringList(body.redactionTerms, old.redactionTerms),
    markdownOutputEnabled: bool("markdownOutputEnabled"), markdownOutputDir: string("markdownOutputDir"),
    llmBaseUrl: validEndpoint(body.llmBaseUrl ?? old.llmBaseUrl),
    llmProtocol: body.llmProtocol === "anthropic" || body.llmProtocol === "openai" ? body.llmProtocol : old.llmProtocol,
    llmModel: string("llmModel"), larkCliPath: string("larkCliPath"), feishuBaseUrl: string("feishuBaseUrl"), feishuWikiNodeToken: string("feishuWikiNodeToken"),
    teamsMeetingEnabled: bool("teamsMeetingEnabled"), teamsAutoRecord: bool("teamsAutoRecord"), whisperCliPath: string("whisperCliPath"), whisperModelPath: string("whisperModelPath"),
    retentionEnabled: bool("retentionEnabled"), evidenceRetentionDays: integer("evidenceRetentionDays", old.evidenceRetentionDays, 1, 3650), meetingAudioRetentionDays: integer("meetingAudioRetentionDays", old.meetingAudioRetentionDays, 0, 3650),
  };
  if (!next.llmModel) throw new Error("LLM 模型不能为空。");
  validateSchedules(next);
  return next;
}
