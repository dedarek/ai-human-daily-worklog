import type { Express } from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWikiTarget } from "./feishu.js";
import { getLarkStatus } from "./larkCli.js";
import { run, runSummary } from "./reportRunner.js";
import { schedule } from "./scheduler.js";
import { dataDir, getSecrets, getSettings, logRun, saveSecrets, saveSettings } from "./store.js";
import { isoDate } from "./time.js";
import type { Settings } from "./types.js";
import { getTeamsMeetingStatus, listTeamsMeetings, startTeamsMeeting, stopTeamsMeeting } from "./teamsMeeting.js";

const legacyKeys = ["feishuAppId", "feishuAppSecret", "feishuFolderToken", "feishuWikiSpaceId", "titlePrefix"];

async function reportRuns() {
  const file = join(dataDir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).flatMap(line => {
    try {
      const entry = JSON.parse(line);
      return String(entry.status).startsWith("sample_") || entry.status === "meeting_recording" ? [] : [entry];
    } catch { return []; }
  });
}

export function registerRoutes(app: Express) {
  app.get("/api/settings", async (_req, res) => res.json(await getSettings()));

  app.post("/api/settings", async (req, res) => {
    const old = await getSettings();
    const body = req.body as Partial<Settings> & { llmApiKey?: string };
    const settings: Settings = {
      ...old, ...body,
      ignoredProcesses: Array.isArray(body.ignoredProcesses) ? body.ignoredProcesses : old.ignoredProcesses,
      teamsMeetingEnabled: body.teamsMeetingEnabled === true,
      teamsAutoRecord: body.teamsAutoRecord === true,
    };
    delete (settings as any).llmApiKey;
    for (const key of legacyKeys) delete (settings as any)[key];
    await saveSettings(settings);
    await saveSecrets(body);
    await schedule();
    res.json({ ok: true });
  });

  app.get("/api/setup/status", async (_req, res) => {
    const settings = await getSettings(); const secrets = await getSecrets();
    try {
      const lark = await getLarkStatus(settings);
      if (lark.binary !== settings.larkCliPath) await saveSettings({ ...settings, larkCliPath: lark.binary });
      res.json({
        lark,
        llmConfigured: Boolean(secrets.llmApiKey && settings.llmBaseUrl && settings.llmModel),
        wikiConfigured: Boolean(settings.feishuWikiNodeToken),
        wikiNodeToken: settings.feishuWikiNodeToken || "",
        ready: lark.verified && lark.identity === "user" && Boolean(settings.feishuWikiNodeToken && secrets.llmApiKey),
      });
    } catch (error) {
      res.json({ lark: { installed: false, error: String(error) }, llmConfigured: Boolean(secrets.llmApiKey), wikiConfigured: Boolean(settings.feishuWikiNodeToken), ready: false });
    }
  });

  app.post("/api/wiki-target", async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) return res.status(400).json({ error: "请粘贴飞书知识库页面链接。" });
    const settings = await getSettings();
    try {
      const target = await resolveWikiTarget(url, settings);
      const updated: Settings = { ...settings, larkCliPath: target.binary, feishuBaseUrl: target.origin, feishuWikiNodeToken: target.nodeToken };
      for (const key of legacyKeys) delete (updated as any)[key];
      await saveSettings(updated);
      res.json({ ok: true, title: target.title, spaceId: target.spaceId, identity: "user" });
    } catch (error) {
      res.status(400).json({ error: `无法通过飞书 CLI 读取知识库：${String(error)}` });
    }
  });

  app.post("/api/run", async (req, res) => {
    const date = req.body?.date || isoDate();
    try { res.json(await run(date, Boolean(req.body?.force))); }
    catch (error) { await logRun({ status: "failed", date, error: String(error) }); res.status(400).json({ error: String(error) }); }
  });

  app.post("/api/run-summary", async (req, res) => {
    const kind = req.body?.kind === "monthly" ? "monthly" : "weekly";
    const start = String(req.body?.start ?? ""); const end = String(req.body?.end ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ error: "请提供正确的开始和结束日期。" });
    try { res.json(await runSummary(kind, start, end, Boolean(req.body?.force ?? true))); }
    catch (error) { await logRun({ status: "failed", kind, start, end, error: String(error) }); res.status(400).json({ error: String(error) }); }
  });

  app.get("/api/meeting/status", async (_req, res) => { try { res.json(await getTeamsMeetingStatus()); } catch (error) { res.status(400).json({ error: String(error) }); } });
  app.get("/api/meetings", async (_req, res) => res.json(await listTeamsMeetings()));
  app.post("/api/meeting/start", async (req, res) => { try { res.json(await startTeamsMeeting("manual", String(req.body?.title ?? ""))); } catch (error) { res.status(400).json({ error: String(error) }); } });
  app.post("/api/meeting/stop", async (_req, res) => { try { res.json(await stopTeamsMeeting()); } catch (error) { res.status(400).json({ error: String(error) }); } });

  app.get("/api/status", async (_req, res) => {
    const settings = await getSettings();
    const runs = await reportRuns();
    res.json({
      running: true,
      schedule: settings.schedule,
      weeklySchedule: settings.weeklySchedule,
      monthlySchedule: settings.monthlySchedule,
      workWindow: "08:00-18:00",
      timezone: settings.timezone,
      dataPath: dataDir,
      lastRun: runs.at(-1) ?? null,
    });
  });

  app.get("/api/runs", async (_req, res) => {
    const runs = await reportRuns();
    res.json(runs.slice(-12).reverse());
  });
}
