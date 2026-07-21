import express from "express";
import cron, { type ScheduledTask } from "node-cron";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { collect } from "./collector.js";
import { publishReport, resolveWikiTarget } from "./feishu.js";
import { getLarkStatus } from "./larkCli.js";
import { writeReport, writeSummaryReport } from "./llm.js";
import { sampleOperation } from "./sampler.js";
import { dataDir, getSecrets, getSettings, logRun, saveSecrets, saveSettings, setupStore } from "./store.js";
import type { Settings } from "./types.js";
import { getTeamsMeetingStatus, listTeamsMeetings, startTeamsMeeting, startTeamsMonitor, stopTeamsMeeting } from "./teamsMeeting.js";

const app = express(); app.use(express.json({ limit: "100kb" })); app.use(express.static(join(process.cwd(), "public")));
let tasks: ScheduledTask[] = [];
const isoDate = (date = new Date(), timezone = "Asia/Shanghai") => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
function dateAdd(date: string, days: number) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function previousDay() { return dateAdd(isoDate(), -1); }
function workdays(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = dateAdd(date, 1)) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); if (day >= 1 && day <= 5) dates.push(date); }
  return dates;
}
function previousMonth(date: string) {
  const current = new Date(`${date.slice(0, 7)}-01T12:00:00Z`); current.setUTCMonth(current.getUTCMonth() - 1);
  const start = current.toISOString().slice(0, 10); current.setUTCMonth(current.getUTCMonth() + 1); current.setUTCDate(0);
  return { start, end: current.toISOString().slice(0, 10), month: start.slice(0, 7) };
}
async function run(date: string, force = false) {
  const settings = await getSettings(); const secrets = await getSecrets();
  const published = join(dataDir, "published.json");
  const publishedIndex = existsSync(published) ? JSON.parse(await readFile(published, "utf8")) : {};
  if (publishedIndex[date] && !force) return { ...publishedIndex[date], skipped: true };
  const { activities, manifest } = await collect(date, settings);
  const verifiedFacts = publishedIndex[date]
    ? ["该日期日报此前已成功写入飞书，本次运行是在原文档上覆盖更新；不得写成飞书写入链路尚未打通。"]
    : [];
  const report = await writeReport(date, activities, settings, secrets, verifiedFacts);
  const doc = await publishReport(date, report, settings, secrets, publishedIndex[date]?.documentId);
  const reportDir = join(dataDir, "reports"); await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, `${date}.md`), report, { mode: 0o600 });
  const index = existsSync(published) ? JSON.parse(await readFile(published, "utf8")) : {}; index[date] = { date, events: activities.length, ...doc }; await writeFile(published, JSON.stringify(index, null, 2), { mode: 0o600 });
  await logRun({ status: "success", date, document: doc, manifest });
  return { date, events: activities.length, ...doc };
}
async function runSummary(kind: "weekly" | "monthly", start: string, end: string, force = true) {
  const settings = await getSettings(); const secrets = await getSecrets();
  const published = join(dataDir, "published.json");
  const publishedIndex = existsSync(published) ? JSON.parse(await readFile(published, "utf8")) : {};
  const key = kind === "weekly" ? `weekly:${start}` : `monthly:${start.slice(0, 7)}`;
  if (publishedIndex[key] && !force) return { ...publishedIndex[key], skipped: true };
  const sourceReports: Array<{ date: string; content: string }> = [];
  for (const date of workdays(start, end)) {
    const file = join(dataDir, "reports", `${date}.md`);
    if (existsSync(file)) sourceReports.push({ date, content: await readFile(file, "utf8") });
  }
  if (!sourceReports.length) throw new Error(`${start} 至 ${end} 没有可用的工作日日报，无法生成汇总。`);
  const label = kind === "weekly" ? `${start} 至 ${end}` : `${start.slice(0, 4)} 年 ${Number(start.slice(5, 7))} 月`;
  const title = kind === "weekly" ? `周报 - ${start} 至 ${end}` : `月报 - ${label}`;
  const report = await writeSummaryReport(kind, label, sourceReports, settings, secrets);
  const doc = await publishReport(start, report, settings, secrets, publishedIndex[key]?.documentId, kind, title);
  const reportDir = join(dataDir, "reports"); await mkdir(reportDir, { recursive: true });
  const filename = kind === "weekly" ? `weekly-${start}.md` : `monthly-${start.slice(0, 7)}.md`;
  await writeFile(join(reportDir, filename), report, { mode: 0o600 });
  const index = existsSync(published) ? JSON.parse(await readFile(published, "utf8")) : {};
  index[key] = { kind, start, end, sourceDays: sourceReports.length, ...doc };
  await writeFile(published, JSON.stringify(index, null, 2), { mode: 0o600 });
  await logRun({ status: "success", kind, start, end, sourceDays: sourceReports.length, document: doc });
  return { kind, start, end, sourceDays: sourceReports.length, ...doc };
}
async function schedule() {
  for (const task of tasks) task.stop(); tasks = []; const s = await getSettings();
  if (!cron.validate(s.schedule)) throw new Error("定时规则无效，请使用 5 段 cron，例如 10 0 * * *。");
  tasks.push(cron.schedule(s.schedule, () => {
    const date = isoDate(new Date(), s.timezone);
    run(date, true).catch(error => logRun({ status: "failed", date, error: String(error) }));
  }, { timezone: s.timezone }));
  tasks.push(cron.schedule("0 8 * * 1", () => {
    const today = isoDate(new Date(), s.timezone); const start = dateAdd(today, -7); const end = dateAdd(today, -3);
    runSummary("weekly", start, end, true).catch(error => logRun({ status: "failed", kind: "weekly", start, end, error: String(error) }));
  }, { timezone: s.timezone }));
  tasks.push(cron.schedule("10 8 1 * *", () => {
    const range = previousMonth(isoDate(new Date(), s.timezone));
    runSummary("monthly", range.start, range.end, true).catch(error => logRun({ status: "failed", kind: "monthly", ...range, error: String(error) }));
  }, { timezone: s.timezone }));
}
app.get("/api/settings", async (_req, res) => res.json(await getSettings()));
app.post("/api/settings", async (req, res) => {
  const old = await getSettings(); const body = req.body as Partial<Settings> & { llmApiKey?: string };
  const settings: Settings = {
    ...old, ...body,
    ignoredProcesses: Array.isArray(body.ignoredProcesses) ? body.ignoredProcesses : old.ignoredProcesses,
    teamsMeetingEnabled: body.teamsMeetingEnabled === true,
    teamsAutoRecord: body.teamsAutoRecord === true,
  };
  delete (settings as any).llmApiKey;
  for (const key of ["feishuAppId", "feishuAppSecret", "feishuFolderToken", "feishuWikiSpaceId"]) delete (settings as any)[key];
  await saveSettings(settings); await saveSecrets(body); await schedule(); res.json({ ok: true });
});
app.get("/api/setup/status", async (_req, res) => {
  const settings = await getSettings(); const secrets = await getSecrets();
  try {
    const lark = await getLarkStatus(settings);
    if (lark.binary !== settings.larkCliPath) await saveSettings({ ...settings, larkCliPath: lark.binary });
    res.json({ lark, llmConfigured: Boolean(secrets.llmApiKey && settings.llmBaseUrl && settings.llmModel), wikiConfigured: Boolean(settings.feishuWikiNodeToken), wikiNodeToken: settings.feishuWikiNodeToken || "", ready: lark.verified && lark.identity === "user" && Boolean(settings.feishuWikiNodeToken && secrets.llmApiKey) });
  } catch (error) { res.json({ lark: { installed: false, error: String(error) }, llmConfigured: Boolean(secrets.llmApiKey), wikiConfigured: Boolean(settings.feishuWikiNodeToken), ready: false }); }
});
app.post("/api/wiki-target", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) return res.status(400).json({ error: "请粘贴飞书知识库页面链接。" });
  const settings = await getSettings();
  try {
    const target = await resolveWikiTarget(url, settings);
    const updated: Settings = { ...settings, larkCliPath: target.binary, feishuBaseUrl: target.origin, feishuWikiNodeToken: target.nodeToken };
    for (const key of ["feishuAppId", "feishuAppSecret", "feishuFolderToken", "feishuWikiSpaceId"]) delete (updated as any)[key];
    await saveSettings(updated);
    res.json({ ok: true, title: target.title, spaceId: target.spaceId, identity: "user" });
  } catch (error) { res.status(400).json({ error: `无法通过飞书 CLI 读取知识库：${String(error)}` }); }
});
app.post("/api/run", async (req, res) => { const date = req.body?.date || isoDate(); try { res.json(await run(date, Boolean(req.body?.force))); } catch (error) { await logRun({ status: "failed", date, error: String(error) }); res.status(400).json({ error: String(error) }); } });
app.post("/api/run-summary", async (req, res) => {
  const kind = req.body?.kind === "monthly" ? "monthly" : "weekly"; const start = String(req.body?.start ?? ""); const end = String(req.body?.end ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "请提供正确的开始和结束日期。" });
  try { res.json(await runSummary(kind, start, end, Boolean(req.body?.force ?? true))); } catch (error) { await logRun({ status: "failed", kind, start, end, error: String(error) }); res.status(400).json({ error: String(error) }); }
});
app.get("/api/meeting/status", async (_req, res) => { try { res.json(await getTeamsMeetingStatus()); } catch (error) { res.status(400).json({ error: String(error) }); } });
app.get("/api/meetings", async (_req, res) => res.json(await listTeamsMeetings()));
app.post("/api/meeting/start", async (req, res) => { try { res.json(await startTeamsMeeting("manual", String(req.body?.title ?? ""))); } catch (error) { res.status(400).json({ error: String(error) }); } });
app.post("/api/meeting/stop", async (_req, res) => { try { res.json(await stopTeamsMeeting()); } catch (error) { res.status(400).json({ error: String(error) }); } });
app.get("/api/status", async (_req, res) => {
  const settings = await getSettings(); const runs = join(dataDir, "runs.jsonl");
  const reportRuns = existsSync(runs) ? (await readFile(runs, "utf8")).trim().split("\n").filter(Boolean).flatMap(line => { try { const entry = JSON.parse(line); return String(entry.status).startsWith("sample_") || entry.status === "meeting_recording" ? [] : [entry]; } catch { return []; } }) : [];
  res.json({ running: true, schedule: settings.schedule, weeklySchedule: "0 8 * * 1", monthlySchedule: "10 8 1 * *", workWindow: "08:00-18:00", timezone: settings.timezone, dataPath: dataDir, lastRun: reportRuns.at(-1) ?? null });
});
app.get("/api/runs", async (_req, res) => {
  const file = join(dataDir, "runs.jsonl");
  if (!existsSync(file)) return res.json([]);
  const entries = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).flatMap(line => { try { const entry = JSON.parse(line); return String(entry.status).startsWith("sample_") || entry.status === "meeting_recording" ? [] : [entry]; } catch { return []; } });
  res.json(entries.slice(-12).reverse());
});
await setupStore(); await schedule(); startTeamsMonitor();
setInterval(() => getSettings().then(sampleOperation).catch(error => logRun({ status: "sample_failed", error: String(error) })), 60_000);
getSettings().then(sampleOperation).catch(error => logRun({ status: "sample_failed", error: String(error) }));
app.listen(4318, "127.0.0.1", () => console.log("Mac Worklog is running at http://127.0.0.1:4318"));
