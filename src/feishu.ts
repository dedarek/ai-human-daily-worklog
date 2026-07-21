import type { Secrets, Settings } from "./types.js";
import { dataDir } from "./store.js";
import { runLarkCli } from "./larkCli.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function calendarKey(date: string) {
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
  const file = join(dataDir, "wiki-index.json"); const index = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  const key = calendarKey(date); const monthKey = `month:${key.month}`;
  if (!index[monthKey]) {
    const created = await createWikiDoc(settings.feishuWikiNodeToken, `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月`, settings);
    index[monthKey] = created.node_token;
  }
  await writeFile(file, JSON.stringify(index, null, 2), { mode: 0o600 }); return index[monthKey] as string;
}

async function wikiParent(date: string, settings: Settings) {
  const file = join(dataDir, "wiki-index.json");
  const key = calendarKey(date); const weekKey = `week:${key.week}`;
  const monthParent = await wikiMonthParent(date, settings);
  const index = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  if (!index[weekKey]) {
    const created = await createWikiDoc(monthParent, key.weekLabel, settings);
    index[weekKey] = created.node_token;
  }
  await writeFile(file, JSON.stringify(index, null, 2), { mode: 0o600 }); return index[weekKey] as string;
}

async function overwriteDocument(documentId: string, report: string, settings: Settings) {
  await runLarkCli(settings, ["docs", "+update", "--as", "user", "--doc", documentId, "--command", "overwrite", "--doc-format", "markdown", "--content", "-", "--json"], { input: report });
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
  const title = customTitle ?? `${settings.titlePrefix} - ${date}`;
  let documentId = existingDocumentId;
  if (!documentId) {
    const parent = kind === "monthly" ? await wikiMonthParent(date, settings) : await wikiParent(date, settings);
    documentId = (await createWikiDoc(parent, title, settings)).obj_token;
  }
  await overwriteDocument(documentId, report, settings);
  const base = (settings.feishuBaseUrl || "https://feishu.cn").replace(/\/$/, "");
  return { title, url: `${base}/docx/${documentId}`, documentId };
}
