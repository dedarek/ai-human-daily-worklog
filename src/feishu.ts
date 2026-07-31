import type { Secrets, Settings } from "./types.js";
import { dataDir } from "./store.js";
import { runLarkCli } from "./larkCli.js";
import { createMutex, readJson, updateJson } from "./jsonStore.js";
import { dailyTitle } from "./titles.js";
import { join } from "node:path";

const wikiTreeLock = createMutex();

export function calendarKey(date: string) {
  const d = new Date(`${date}T12:00:00Z`); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { month: date.slice(0, 7), week: `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, weekLabel: `${d.getUTCFullYear()} 年第 ${week} 周` };
}

async function createWikiDoc(parent: string, title: string, settings: Settings) {
  const { body } = await runLarkCli(settings, ["wiki", "+node-create", "--as", "user", "--parent-node-token", parent, "--title", title, "--obj-type", "docx", "--json"]);
  const node = body.data;
  if (!node?.node_token || !node?.obj_token) throw new Error("飞书 CLI 创建知识库节点成功，但没有返回文档标识。");
  return node as { node_token: string; obj_token: string; title: string };
}

async function wikiMonthParent(date: string, settings: Settings) {
  if (!settings.feishuWikiNodeToken) throw new Error("请先在初始化页面绑定飞书知识库父页面。");
  const file = join(dataDir, "wiki-index.json");
  const key = calendarKey(date); const monthKey = `month:${key.month}`;
  return wikiTreeLock(async () => {
    const current = await readJson<Record<string, string>>(file, {});
    if (current[monthKey]) return current[monthKey];
    const created = await createWikiDoc(settings.feishuWikiNodeToken!, `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`, settings);
    const index = await updateJson<Record<string, string>>(file, {}, latest => latest[monthKey] ? latest : { ...latest, [monthKey]: created.node_token });
    return index[monthKey];
  });
}

async function wikiParent(date: string, settings: Settings) {
  const file = join(dataDir, "wiki-index.json");
  const key = calendarKey(date); const weekKey = `week:${key.week}`;
  const monthParent = await wikiMonthParent(date, settings);
  return wikiTreeLock(async () => {
    const current = await readJson<Record<string, string>>(file, {});
    if (current[weekKey]) return current[weekKey];
    const created = await createWikiDoc(monthParent, key.weekLabel, settings);
    const index = await updateJson<Record<string, string>>(file, {}, latest => latest[weekKey] ? latest : { ...latest, [weekKey]: created.node_token });
    return index[weekKey];
  });
}

async function overwriteDocument(documentId: string, report: string, settings: Settings) {
  await runLarkCli(settings, ["docs", "+update", "--as", "user", "--doc", documentId, "--command", "overwrite", "--doc-format", "xml", "--content", "-", "--json"], { input: report });
}

export async function resolveWikiTarget(url: string, settings: Settings) {
  const { body, binary } = await runLarkCli(settings, ["wiki", "+node-get", "--as", "user", "--node-token", url, "--json"]);
  const node = body.data;
  if (!node?.node_token || !node?.space_id) throw new Error("飞书 CLI 未能解析该知识库页面。");
  let origin = "https://feishu.cn";
  try { origin = new URL(url).origin; } catch { /* raw token */ }
  return { nodeToken: node.node_token as string, spaceId: node.space_id as string, title: node.title as string, origin, binary };
}

export async function publishReport(date: string, report: string, settings: Settings, _secrets: Secrets, existingDocumentId?: string, kind: "daily" | "weekly" | "monthly" | "meeting" = "daily", customTitle?: string) {
  const title = customTitle ?? dailyTitle(date);
  const createFresh = async () => {
    const parent = kind === "monthly" ? await wikiMonthParent(date, settings) : await wikiParent(date, settings);
    return (await createWikiDoc(parent, title, settings)).obj_token as string;
  };
  let documentId = existingDocumentId ?? await createFresh();
  try {
    await overwriteDocument(documentId, report, settings);
  } catch (error) {
    // WHY 自愈：目标文档被用户删除/移入回收站后无法再覆盖，此时重建一篇而非整体失败。
    if (existingDocumentId && /deleted|no longer be edited|trash|not\s*exist|not\s*found|permission/i.test(String(error))) {
      documentId = await createFresh();
      await overwriteDocument(documentId, report, settings);
    } else throw error;
  }
  const base = (settings.feishuBaseUrl || "https://feishu.cn").replace(/\/$/, "");
  return { title, url: `${base}/docx/${documentId}`, documentId };
}
