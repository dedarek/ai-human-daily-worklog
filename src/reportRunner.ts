import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collect } from "./collector.js";
import { publishReport } from "./feishu.js";
import { writeReport, writeSummaryReport, sourceSummaryLine } from "./llm.js";
import { dataDir, getSecrets, getSettings, logRun } from "./store.js";
import { readJson, updateJson, createMutex } from "./jsonStore.js";
import { workdays } from "./time.js";
import { weeklyTitle, monthlyTitle } from "./titles.js";
import { dailyXml, summaryXml } from "./render.js";

type PublishedEntry = { documentId?: string; url?: string; title?: string; [key: string]: unknown };
type PublishedIndex = Record<string, PublishedEntry>;

const publishedFile = join(dataDir, "published.json");

// 所有报告生成串行执行，避免 cron 与手动 /api/run 并发覆盖同一文档/索引。
const runReport = createMutex();

export function run(date: string, force = false) {
  return runReport(async () => {
    const settings = await getSettings(); const secrets = await getSecrets();
    const publishedIndex = await readJson<PublishedIndex>(publishedFile, {});
    if (publishedIndex[date] && !force) return { ...publishedIndex[date], skipped: true };
    const { activities, manifest } = await collect(date, settings);
    const verifiedFacts = publishedIndex[date]
      ? ["该日期日报此前已成功写入飞书，本次运行是在原文档上覆盖更新；不得写成飞书写入链路尚未打通。"]
      : [];
    const report = await writeReport(date, activities, settings, secrets, verifiedFacts);
    const xml = dailyXml(report, { date, sourceSummary: sourceSummaryLine(activities) });
    const doc = await publishReport(date, xml, settings, secrets, publishedIndex[date]?.documentId);
    const reportDir = join(dataDir, "reports"); await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, `${date}.md`), report, { mode: 0o600 });
    await updateJson<PublishedIndex>(publishedFile, {}, index => ({ ...index, [date]: { date, events: activities.length, ...doc } }));
    await logRun({ status: "success", date, document: doc, manifest });
    return { date, events: activities.length, ...doc };
  });
}

export function runSummary(kind: "weekly" | "monthly", start: string, end: string, force = true) {
  return runReport(async () => {
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
    const doc = await publishReport(start, summaryXml(report, { label }), settings, secrets, publishedIndex[key]?.documentId, kind, title);
    const reportDir = join(dataDir, "reports"); await mkdir(reportDir, { recursive: true });
    const filename = kind === "weekly" ? `weekly-${start}.md` : `monthly-${start.slice(0, 7)}.md`;
    await writeFile(join(reportDir, filename), report, { mode: 0o600 });
    await updateJson<PublishedIndex>(publishedFile, {}, index => ({ ...index, [key]: { kind, start, end, sourceDays: sourceReports.length, ...doc } }));
    await logRun({ status: "success", kind, start, end, sourceDays: sourceReports.length, document: doc });
    return { kind, start, end, sourceDays: sourceReports.length, ...doc };
  });
}
