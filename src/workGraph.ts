import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "./store.js";
import { readJson, updateJson, atomicWriteFile } from "./jsonStore.js";
import type { Activity, ArtifactType, EvidenceClaim, GapQuestion, ReportTrace, WorkArtifact, WorkChain, WorkGraph, WorkProject } from "./types.js";

export type WorkPreferences = {
  projectAliases: Record<string, string>;
  ignoredPatterns: string[];
  sectionTargets: Record<string, number>;
  learnedAt?: string;
};

export const emptyPreferences = (): WorkPreferences => ({ projectAliases: {}, ignoredPatterns: [], sectionTargets: {} });
const id = (prefix: string, value: string) => `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
const generic = new Set(["src", "source", "app", "apps", "code", "repo", "repos", "project", "projects", "workspace", "workspaces", "users", "home", "documents", "desktop", "downloads"]);

function pathProject(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const markers = ["个人项目", "projects", "project", "repos", "workspace", "workspaces"];
  for (let index = parts.length - 2; index >= 0; index--) {
    if (markers.includes(parts[index].toLowerCase())) return parts[index + 1];
  }
  const candidate = parts.at(-1)?.replace(/\.(?:git|ts|js|json|md|tsx|jsx|py|go|rs)$/i, "") || "";
  return generic.has(candidate.toLowerCase()) ? "" : candidate;
}

export function projectHint(activity: Activity, preferences: WorkPreferences = emptyPreferences()) {
  const text = activity.message;
  const explicit = text.match(/(?:项目|project)\s*[：:]?\s*([\p{L}\p{N}_.-]{2,60})/iu)?.[1];
  const github = text.match(/github\.com[/:]([\w.-]+\/[\w.-]+)/i)?.[1]?.split("/").at(-1);
  const cwd = text.match(/(?:目录|cwd)\s*[：:]\s*([^）)；;]+)/iu)?.[1];
  const file = text.match(/(?:文件|path)\s*[：:]\s*([^；;]+)/iu)?.[1];
  const raw = explicit || github || (cwd && pathProject(cwd)) || (file && pathProject(file)) || "";
  const clean = raw.replace(/^['"]|['"]$/g, "").trim();
  return preferences.projectAliases[clean] || clean;
}

function artifactFrom(activity: Activity, projectId: string): WorkArtifact | null {
  const text = activity.message;
  const definitions: Array<[ArtifactType, RegExp]> = [
    ["pull_request", /(?:gh\s+pr|pull request|\bPR\s*#)/i],
    ["release", /(?:gh\s+release|发布\s+v?\d|release\s+v?\d)/i],
    ["commit", /(?:git\s+commit|提交\s+[0-9a-f]{7,40}|commit\s+[0-9a-f]{7,40})/i],
    ["deployment", /(?:deploy|deployment|部署|上线)/i],
    ["test", /(?:npm\s+(?:run\s+)?test|pytest|测试(?:通过|完成)|\d+\/\d+.*测试)/i],
    ["build", /(?:npm\s+run\s+build|electron-builder|构建(?:成功|完成)|打包)/i],
    ["document", /(?:创建|更新|写入|发布).{0,10}(?:文档|README|报告)/i],
    ["file", /(?:修改|创建|写入|删除)文件[：:]/i],
    ["decision", /(?:决定|决策|确认采用|最终选择)/i],
  ];
  const type = definitions.find(([, pattern]) => pattern.test(text))?.[0];
  if (!type) return null;
  const reference = text.match(/https?:\/\/\S+/)?.[0]?.replace(/[),，。]+$/, "") || text.match(/[0-9a-f]{7,40}/i)?.[0];
  return {
    id: id("artifact", `${activity.evidenceId}|${type}`), type, title: text.slice(0, 240), timestamp: activity.timestamp,
    projectId, evidenceIds: [activity.evidenceId], verified: /(?:通过|成功|完成|已发布|已合并|uploaded|success|committed|created commit)/i.test(text), reference,
  };
}

const isIntent = (activity: Activity) => /^(?:提问|任务|讨论)[：:]/.test(activity.message) || activity.process === "Teams Meeting";

function buildChains(projectId: string, projectName: string, activities: Activity[], artifacts: WorkArtifact[]): WorkChain[] {
  const chains: WorkChain[] = [];
  let current: WorkChain | undefined;
  for (const activity of activities) {
    if (!current || isIntent(activity)) {
      current = {
        id: id("chain", `${projectId}|${activity.evidenceId}`), projectId,
        title: isIntent(activity) ? activity.message.replace(/^(?:提问|任务|讨论)[：:]\s*/, "").slice(0, 100) : `持续推进 ${projectName}`,
        intent: isIntent(activity) ? { summary: activity.message.slice(0, 300), evidenceId: activity.evidenceId, timestamp: activity.timestamp } : undefined,
        steps: [], artifacts: [], outcome: "尚无可确认产物", status: "in_progress", confidence: 0.35,
      };
      chains.push(current);
    }
    current.steps.push({ summary: activity.message.slice(0, 300), evidenceId: activity.evidenceId, timestamp: activity.timestamp });
    const produced = artifacts.filter(item => item.evidenceIds.includes(activity.evidenceId));
    current.artifacts.push(...produced);
  }
  for (const chain of chains) {
    if (chain.artifacts.length) {
      chain.outcome = chain.artifacts.map(item => item.title).slice(0, 3).join("；");
      chain.status = chain.artifacts.some(item => item.verified) ? "verified" : "produced";
      chain.confidence = Math.min(0.98, 0.58 + chain.artifacts.length * 0.1 + (chain.intent ? 0.12 : 0));
    } else if (!chain.intent && chain.steps.length < 2) {
      chain.status = "uncertain"; chain.confidence = 0.25;
    } else chain.confidence = Math.min(0.7, 0.38 + chain.steps.length * 0.04 + (chain.intent ? 0.1 : 0));
  }
  return chains;
}

export async function buildWorkGraph(date: string, activities: Activity[], preferences: WorkPreferences = emptyPreferences(), persist = true): Promise<WorkGraph> {
  const buckets = new Map<string, { name: string; aliases: Set<string>; activities: Activity[] }>();
  const unassigned: string[] = [];
  const ordered = [...activities].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const directHints = ordered.map(activity => projectHint(activity, preferences));
  const contextualSources = new Set(["Claude Code", "Codex", "OpenCode", "Terminal", "Teams Meeting", "Copilot", "ZCode"]);
  const resolvedHints = ordered.map((activity, index) => {
    if (directHints[index]) return directHints[index];
    if (!contextualSources.has(activity.process) && !isIntent(activity)) return "";
    const at = new Date(activity.timestamp).getTime();
    const candidates = directHints.flatMap((hint, candidateIndex) => {
      if (!hint) return [];
      const distance = Math.abs(new Date(ordered[candidateIndex].timestamp).getTime() - at);
      return distance <= 30 * 60 * 1000 ? [{ hint, distance, directionPenalty: candidateIndex < index ? 0 : 1 }] : [];
    }).sort((a, b) => a.distance - b.distance || a.directionPenalty - b.directionPenalty);
    return candidates[0]?.hint || "";
  });
  for (const [index, activity] of ordered.entries()) {
    if (preferences.ignoredPatterns.some(pattern => pattern && activity.message.toLowerCase().includes(pattern.toLowerCase()))) continue;
    const hint = resolvedHints[index];
    const name = hint || "未归类工作";
    if (!hint) unassigned.push(activity.evidenceId);
    const projectId = id("project", name.toLowerCase());
    const bucket = buckets.get(projectId) ?? { name, aliases: new Set<string>(), activities: [] };
    if (hint) bucket.aliases.add(hint);
    bucket.activities.push(activity); buckets.set(projectId, bucket);
  }
  const projects: WorkProject[] = [...buckets].map(([projectId, bucket]) => {
    const artifacts = bucket.activities.map(item => artifactFrom(item, projectId)).filter((item): item is WorkArtifact => Boolean(item));
    return {
      id: projectId, name: bucket.name, aliases: [...bucket.aliases], evidenceIds: bucket.activities.map(item => item.evidenceId), artifacts,
      chains: buildChains(projectId, bucket.name, bucket.activities, artifacts), firstSeenAt: bucket.activities[0].timestamp, lastSeenAt: bucket.activities.at(-1)!.timestamp,
    };
  });
  const graph = { date, generatedAt: new Date().toISOString(), projects, unassignedEvidenceIds: unassigned };
  if (persist) {
    const directory = join(dataDir, "work-graphs"); await mkdir(directory, { recursive: true });
    await atomicWriteFile(join(directory, `${date}.json`), JSON.stringify(graph, null, 2));
  }
  return graph;
}

function tokens(value: string) {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  const words = normalized.split(/\s+/).filter(word => word.length >= 2);
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  for (let index = 0; index < han.length - 1; index++) words.push(`${han[index]}${han[index + 1]}`);
  return new Set(words);
}

function similarity(left: string, right: string) {
  const a = tokens(left), b = tokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0; for (const item of a) if (b.has(item)) overlap++;
  return overlap / Math.min(a.size, b.size);
}

export function buildReportTrace(date: string, report: string, activities: Activity[], graph: WorkGraph): ReportTrace {
  let section = ""; const claims: EvidenceClaim[] = [];
  const projectByEvidence = new Map(graph.projects.flatMap(project => project.evidenceIds.map(evidenceId => [evidenceId, project] as const)));
  const blocks = report.split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
  for (const block of blocks) {
    if (/^#{1,3}\s/.test(block)) { section = block.replace(/^#+\s*/, ""); continue; }
    for (const line of block.split(/\n/).map(value => value.replace(/^[-*]\s+/, "").trim()).filter(Boolean)) {
      const ranked = activities.map(activity => ({ activity, score: similarity(line, activity.message) })).sort((a, b) => b.score - a.score);
      const selected = ranked.filter(item => item.score >= 0.18).slice(0, 4);
      const evidenceIds = selected.map(item => item.activity.evidenceId);
      const project = evidenceIds.map(evidenceId => projectByEvidence.get(evidenceId)).find(Boolean);
      const best = selected[0]?.score ?? 0;
      // 这里只能表达词汇层面的证据匹配，不能冒充事实蕴含或真实性评分。
      const confidence = Math.min(0.74, evidenceIds.length ? 0.28 + best * 0.35 + Math.min(0.1, evidenceIds.length * 0.025) : 0.08);
      claims.push({ id: id("claim", `${date}|${section}|${line}`), section, text: line, projectId: project?.id, evidenceIds, confidence: Number(confidence.toFixed(2)) });
    }
  }
  return { date, generatedAt: new Date().toISOString(), claims };
}

export function detectEvidenceGaps(graph: WorkGraph): GapQuestion[] {
  const questions: GapQuestion[] = [];
  for (const project of graph.projects.filter(item => item.name !== "未归类工作")) {
    const unfinished = project.chains.find(chain => chain.intent && !chain.artifacts.length && chain.steps.length >= 2);
    if (unfinished) questions.push({ id: id("gap", unfinished.id), projectId: project.id, question: `“${unfinished.title}”今天最终做到什么状态？`, reason: "检测到明确意图和执行过程，但没有可确认的产物或结果。", evidenceIds: unfinished.steps.map(step => step.evidenceId) });
  }
  if (graph.unassignedEvidenceIds.length >= 3) questions.push({ id: id("gap", `${graph.date}|unassigned`), projectId: "unassigned", question: "今天这些未归类操作主要属于哪个项目？", reason: "多条工作证据无法稳定归入项目。", evidenceIds: graph.unassignedEvidenceIds.slice(0, 20) });
  return questions.slice(0, 2);
}

export async function getWorkPreferences() {
  return readJson<WorkPreferences>(join(dataDir, "preferences.json"), emptyPreferences());
}

function sectionLengths(markdown: string) {
  const result: Record<string, number> = {};
  const matches = [...markdown.matchAll(/^##\s+(.+)\n+([\s\S]*?)(?=^##\s+|$)/gm)];
  for (const match of matches) result[match[1].trim()] = match[2].replace(/\s+/g, "").length;
  return result;
}

export function applyCorrectionPreferences(preferences: WorkPreferences, _original: string, edited: string, aliases: Record<string, string> = {}): WorkPreferences {
    const targets = sectionLengths(edited);
    const sectionTargets = { ...preferences.sectionTargets };
    for (const [section, length] of Object.entries(targets)) {
      const previous = sectionTargets[section];
      sectionTargets[section] = previous ? Math.round(previous * 0.7 + length * 0.3) : length;
    }
    return {
      projectAliases: { ...preferences.projectAliases, ...aliases },
      // 删除某一段可能只是当天不重要，不能据此永久屏蔽整个项目。
      ignoredPatterns: preferences.ignoredPatterns,
      sectionTargets,
      learnedAt: new Date().toISOString(),
    };
}

export async function learnFromCorrection(original: string, edited: string, aliases: Record<string, string> = {}) {
  return updateJson<WorkPreferences>(join(dataDir, "preferences.json"), emptyPreferences(), preferences => applyCorrectionPreferences(preferences, original, edited, aliases));
}

export function preferencePrompt(preferences: WorkPreferences) {
  const aliases = Object.entries(preferences.projectAliases).map(([from, to]) => `${from}→${to}`).join("；");
  const lengths = Object.entries(preferences.sectionTargets).map(([section, length]) => `${section}约${length}字`).join("；");
  return [aliases && `项目别名：${aliases}`, preferences.ignoredPatterns.length && `用户曾删除的低价值主题：${preferences.ignoredPatterns.join("、")}`, lengths && `用户接受的篇幅：${lengths}`].filter(Boolean).join("\n") || "无";
}

export async function loadWorkGraph(date: string) {
  return readJson<WorkGraph | null>(join(dataDir, "work-graphs", `${date}.json`), null);
}

export async function saveReportTrace(trace: ReportTrace) {
  const directory = join(dataDir, "report-traces"); await mkdir(directory, { recursive: true });
  await atomicWriteFile(join(directory, `${trace.date}.json`), JSON.stringify(trace, null, 2));
}

export async function loadReportTrace(date: string) {
  return readJson<ReportTrace | null>(join(dataDir, "report-traces", `${date}.json`), null);
}

export type ArchiveSearchResult = { id: string; date: string; source: "report" | "project"; title: string; snippet: string; score: number; evidenceIds: string[]; path: string };

type IndexedArchive = Omit<ArchiveSearchResult, "score" | "snippet"> & { content: string };
let archiveCache: { signature: string; entries: IndexedArchive[] } | null = null;

async function archiveEntries() {
  const reportDir = join(dataDir, "reports"), graphDir = join(dataDir, "work-graphs");
  const files = [
    ...((existsSync(reportDir) ? await readdir(reportDir) : []).filter(name => name.endsWith(".md")).map(name => ({ source: "report" as const, name, path: join(reportDir, name) }))),
    ...((existsSync(graphDir) ? await readdir(graphDir) : []).filter(name => name.endsWith(".json")).map(name => ({ source: "project" as const, name, path: join(graphDir, name) }))),
  ];
  const signature = (await Promise.all(files.map(async file => `${file.path}:${(await stat(file.path)).mtimeMs}`))).join("|");
  if (archiveCache?.signature === signature) return archiveCache.entries;
  const entries: IndexedArchive[] = [];
  for (const file of files) {
    if (file.source === "report") {
      const content = await readFile(file.path, "utf8");
      entries.push({ id: id("search", file.path), date: file.name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || file.name, source: "report", title: content.match(/^#\s+(.+)$/m)?.[1] || file.name, evidenceIds: [], path: file.path, content });
    } else {
      const graph = JSON.parse(await readFile(file.path, "utf8")) as WorkGraph;
      for (const project of graph.projects) entries.push({ id: id("search", `${file.path}|${project.id}`), date: graph.date, source: "project", title: project.name, evidenceIds: project.evidenceIds.slice(0, 20), path: file.path, content: `${project.name} ${project.chains.map(chain => `${chain.title}：${chain.outcome}`).join("；")}` });
    }
  }
  archiveCache = { signature, entries };
  return entries;
}

export async function searchArchive(query: string, limit = 12): Promise<ArchiveSearchResult[]> {
  const clean = query.trim(); if (!clean) return [];
  const results: ArchiveSearchResult[] = [];
  for (const entry of await archiveEntries()) {
    const score = similarity(clean, entry.content); if (score <= 0) continue;
    const lines = entry.content.split("\n").filter(line => similarity(clean, line) > 0).slice(0, 3);
    const { content, ...metadata } = entry;
    results.push({ ...metadata, snippet: (lines.join(" ") || content).slice(0, 500), score: score + (entry.source === "project" ? 0.1 : 0) });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit).map(item => ({ ...item, score: Number(item.score.toFixed(3)) }));
}
