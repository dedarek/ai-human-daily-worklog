import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callModel } from "./llm.js";
import { dataDir, getSecrets, getSettings, logRun } from "./store.js";
import { dateAdd } from "./time.js";
import { loadWorkGraph } from "./workGraph.js";

export function previousWorkdays(date: string, count = 3) {
  const dates: string[] = []; let cursor = date;
  while (dates.length < count) {
    cursor = dateAdd(cursor, -1);
    const day = new Date(`${cursor}T12:00:00Z`).getUTCDay();
    if (day >= 1 && day <= 5) dates.push(cursor);
  }
  return dates;
}

export async function createMorningBrief(date: string, force = false) {
  const path = join(dataDir, "briefs", `${date}.md`);
  if (!force && existsSync(path)) return { date, content: await readFile(path, "utf8"), path, skipped: true };
  const sources: string[] = []; const fallbackProjects: string[] = [];
  for (const day of previousWorkdays(date, 5)) {
    const reportPath = join(dataDir, "reports", `${day}.md`);
    if (existsSync(reportPath)) sources.push(`===== ${day} 日报 =====\n${(await readFile(reportPath, "utf8")).slice(0, 4500)}`);
    const graph = await loadWorkGraph(day);
    if (graph) for (const project of graph.projects) for (const chain of project.chains.filter(item => item.status !== "verified")) fallbackProjects.push(`${project.name}：${chain.title}（${chain.status}）`);
  }
  if (!sources.length && !fallbackProjects.length) throw new Error("近期没有可用于晨间续接的工作档案。");
  const settings = await getSettings(); const secrets = await getSecrets();
  let content: string;
  try {
    content = (await callModel(`依据最近工作档案生成 ${date} 的晨间续接。只恢复已有上下文，不编造新计划。使用以下结构：\n# ${date} 晨间续接\n## 活跃项目\n## 未决事项与承诺\n## 建议首先恢复的上下文\n\n每条内容说明来自哪个日期。不要写工具流水。\n\n${sources.join("\n").slice(0, 30000)}`, settings, secrets, 900)).trim();
  } catch {
    content = `# ${date} 晨间续接\n\n## 活跃项目\n\n${fallbackProjects.slice(0, 10).map(item => `- ${item}`).join("\n") || "- 请查看最近一份工作日报。"}\n\n## 未决事项与承诺\n\n- 根据最近工作档案继续确认未完成事项。\n\n## 建议首先恢复的上下文\n\n- 打开最近日报并确认各项目当前状态。`;
  }
  await mkdir(join(dataDir, "briefs"), { recursive: true }); await writeFile(path, content, { mode: 0o600 });
  await logRun({ status: "success", kind: "morning", date, path });
  return { date, content, path };
}

export async function getMorningBrief(date: string) {
  const path = join(dataDir, "briefs", `${date}.md`);
  return existsSync(path) ? { date, content: await readFile(path, "utf8"), path } : null;
}
