import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collect } from "./collector.js";
import { publishReport } from "./feishu.js";
import { writeReport, writeSummaryReport } from "./llm.js";
import { dataDir, getSecrets, getSettings, logRun } from "./store.js";
import { readJson, updateJson, createMutex, atomicWriteFile } from "./jsonStore.js";
import { workdays } from "./time.js";
import { dailyTitle, weeklyTitle, monthlyTitle } from "./titles.js";
import { dailyXml, summaryXml } from "./render.js";
import { writeMarkdownExport } from "./markdown.js";
import type { DailyDraft } from "./types.js";
import { buildReportTrace, buildWorkGraph, detectEvidenceGaps, getWorkPreferences, learnFromCorrection, saveReportTrace } from "./workGraph.js";

type PublishedEntry = { documentId?: string; url?: string; title?: string; [key: string]: unknown };
type PublishedIndex = Record<string, PublishedEntry>;

const publishedFile = join(dataDir, "published.json");
const draftsDir = join(dataDir, "drafts");

// 同一报告串行，不同日期/周期可独立运行；published.json 自身另有文件锁。
const reportLocks = new Map<string, { run: ReturnType<typeof createMutex>; pending: number }>();
function runReport<T>(key: string, action: () => Promise<T>) {
  let entry = reportLocks.get(key);
  if (!entry) { entry = { run: createMutex(), pending: 0 }; reportLocks.set(key, entry); }
  entry.pending++;
  return entry.run(action).finally(() => {
    entry!.pending--;
    if (entry!.pending === 0 && reportLocks.get(key) === entry) reportLocks.delete(key);
  });
}

async function saveDraft(draft: DailyDraft) {
  await mkdir(draftsDir, { recursive: true });
  await atomicWriteFile(join(draftsDir, `${draft.date}.json`), JSON.stringify(draft, null, 2));
  return draft;
}

export function getDailyDraft(date: string) {
  return readJson<DailyDraft | null>(join(draftsDir, `${date}.json`), null);
}

async function generateDailyDraft(date: string, answers: Record<string, string> = {}, previous?: DailyDraft | null): Promise<DailyDraft> {
  const settings = await getSettings(); const secrets = await getSecrets(); const published = await readJson<PublishedIndex>(publishedFile, {});
  const { activities, manifest } = await collect(date, settings);
  const preferences = await getWorkPreferences();
  const graph = await buildWorkGraph(date, activities, preferences);
  const gaps = detectEvidenceGaps(graph);
  const verifiedFacts = published[date] ? ["该日期日报此前已成功写入飞书，本次运行是在原文档上覆盖更新；不得写成飞书写入链路尚未打通。"] : [];
  const report = await writeReport(date, activities, settings, secrets, verifiedFacts, { graph, answers, preferences });
  const trace = buildReportTrace(date, report, activities, graph); await saveReportTrace(trace);
  const now = new Date().toISOString();
  return saveDraft({ date, status: "draft", version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt || now, updatedAt: now, originalReport: report, editedReport: report, graph, trace, gaps, answers, events: activities.length, manifest });
}

export function createDailyDraft(date: string, force = false, answers: Record<string, string> = {}) {
  return runReport(`daily:${date}`, async () => {
    const existing = await getDailyDraft(date);
    if (existing && !force) return existing;
    return generateDailyDraft(date, answers, existing);
  });
}

export function updateDailyDraft(date: string, input: { editedReport?: string; answers?: Record<string, string>; aliases?: Record<string, string>; regenerate?: boolean }) {
  return runReport(`daily:${date}`, async () => {
    const draft = await getDailyDraft(date); if (!draft) throw new Error("尚未生成该日期的预览草稿。");
    const answers = { ...draft.answers, ...(input.answers || {}) };
    if (input.editedReport || Object.keys(input.aliases || {}).length) await learnFromCorrection(draft.originalReport, input.editedReport || draft.editedReport, input.aliases);
    const settings = await getSettings(); const { activities } = await collect(date, settings); const preferences = await getWorkPreferences();
    const graph = await buildWorkGraph(date, activities, preferences);
    const editedReport = input.regenerate
      ? await writeReport(date, activities, settings, await getSecrets(), [], { graph, answers, preferences })
      : (input.editedReport?.trim() || draft.editedReport);
    const trace = buildReportTrace(date, editedReport, activities, graph); await saveReportTrace(trace);
    return saveDraft({ ...draft, editedReport, graph, trace, gaps: detectEvidenceGaps(graph), answers, version: draft.version + 1, updatedAt: new Date().toISOString() });
  });
}

async function publishDraft(draft: DailyDraft) {
  const settings = await getSettings(); const secrets = await getSecrets(); const publishedIndex = await readJson<PublishedIndex>(publishedFile, {});
  const report = draft.editedReport.trim(); if (!report) throw new Error("草稿内容为空，无法发布。");
  const sourceSummary = draft.graph.projects.map(project => `${project.name}: ${project.evidenceIds.length} 条`).join("；");
  const doc: PublishedEntry = settings.feishuWikiNodeToken
    ? await publishReport(draft.date, dailyXml(report, { date: draft.date, title: dailyTitle(draft.date), sourceSummary }), settings, secrets, publishedIndex[draft.date]?.documentId)
    : { title: dailyTitle(draft.date) };
  // 远端成功后优先记录文档 ID。后续本地写入即使失败，重试也会覆盖同一文档而不是重复创建。
  if (doc.documentId) await updateJson<PublishedIndex>(publishedFile, {}, index => ({ ...index, [draft.date]: { date: draft.date, events: draft.events, ...doc, localState: "pending" } }));
  const reportDir = join(dataDir, "reports"); await mkdir(reportDir, { recursive: true });
  await atomicWriteFile(join(reportDir, `${draft.date}.md`), report);
  const markdownPath = await writeMarkdownExport(`daily-${draft.date}.md`, report, settings);
  await updateJson<PublishedIndex>(publishedFile, {}, index => ({ ...index, [draft.date]: { date: draft.date, events: draft.events, ...doc, localState: "complete" } }));
  const publishedDraft = await saveDraft({ ...draft, status: "published", published: doc, updatedAt: new Date().toISOString() });
  await logRun({ status: "success", date: draft.date, document: doc, manifest: draft.manifest, markdownPath, draftVersion: draft.version });
  return { date: draft.date, events: draft.events, markdownPath, ...doc, draft: publishedDraft };
}

export function publishDailyDraft(date: string) {
  return runReport(`daily:${date}`, async () => {
    const draft = await getDailyDraft(date); if (!draft) throw new Error("尚未生成该日期的预览草稿。");
    return publishDraft(draft);
  });
}

export function run(date: string, force = false) {
  return runReport(`daily:${date}`, async () => {
    const published = await readJson<PublishedIndex>(publishedFile, {});
    if (published[date] && !force) return { ...published[date], skipped: true };
    return publishDraft(await generateDailyDraft(date, {}, await getDailyDraft(date)));
  });
}

export function runSummary(kind: "weekly" | "monthly", start: string, end: string, force = true) {
  return runReport(`${kind}:${start}`, async () => {
    const settings = await getSettings(); const secrets = await getSecrets();
    const publishedIndex = await readJson<PublishedIndex>(publishedFile, {});
    const key = kind === "weekly" ? `weekly:${start}` : `monthly:${start.slice(0, 7)}`;
    if (publishedIndex[key] && !force) return { ...publishedIndex[key], skipped: true };
    const sourceReports: Array<{ date: string; content: string }> = [];
    for (const date of workdays(start, end)) {
      const file = join(dataDir, "reports", `${date}.md`);
      if (existsSync(file)) sourceReports.push({ date, content: await readFile(file, "utf8") });
    }
    if (!sourceReports.length) throw new Error(`${start} 至 ${end} 没有可用的工作日日报，无法生成汇总。`);
    const label = kind === "weekly" ? `${start} 至 ${end}` : `${start.slice(0, 4)} 年 ${Number(start.slice(5, 7))} 月`;
    const title = kind === "weekly" ? weeklyTitle(start, end) : monthlyTitle(start);
    const report = await writeSummaryReport(kind, label, sourceReports, settings, secrets);
    const doc: PublishedEntry = settings.feishuWikiNodeToken
      ? await publishReport(start, summaryXml(report, { label, title }), settings, secrets, publishedIndex[key]?.documentId, kind, title)
      : { title };
    if (doc.documentId) await updateJson<PublishedIndex>(publishedFile, {}, index => ({ ...index, [key]: { kind, start, end, sourceDays: sourceReports.length, ...doc, localState: "pending" } }));
    const reportDir = join(dataDir, "reports"); await mkdir(reportDir, { recursive: true });
    const filename = kind === "weekly" ? `weekly-${start}.md` : `monthly-${start.slice(0, 7)}.md`;
    await atomicWriteFile(join(reportDir, filename), report);
    const markdownPath = await writeMarkdownExport(filename, report, settings);
    await updateJson<PublishedIndex>(publishedFile, {}, index => ({ ...index, [key]: { kind, start, end, sourceDays: sourceReports.length, ...doc, localState: "complete" } }));
    await logRun({ status: "success", kind, start, end, sourceDays: sourceReports.length, markdownPath, document: doc });
    return { kind, start, end, sourceDays: sourceReports.length, markdownPath, ...doc };
  });
}
