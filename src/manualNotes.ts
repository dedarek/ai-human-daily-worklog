import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir, getSecrets, getSettings, saveSettings } from "./store.js";
import { readJson, updateJson } from "./jsonStore.js";
import { isoDate } from "./time.js";
import { publishReport, resolveWikiTarget } from "./feishu.js";
import { renderDocXml } from "./render.js";
import { getLarkStatus } from "./larkCli.js";
import { beginLarkLogin } from "./onboarding.js";
import { searchArchive } from "./workGraph.js";

export type ManualNote = {
  id: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  content: string;
  context?: string;
  project?: string;
  kind?: string;
  tags: string[];
  source: "chatgpt";
};

export type ManualNoteInput = {
  content: string;
  context?: string;
  project?: string;
  kind?: string;
  tags?: string[];
};

export type ManualNotePatch = Partial<Omit<ManualNoteInput, "tags">> & { tags?: string[] };

const notesFile = join(dataDir, "manual-notes.json");
const syncIndexFile = join(dataDir, "manual-notes-feishu.json");

type SyncIndex = Record<string, { documentId?: string; url?: string; title?: string; updatedAt?: string }>;

function compact(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().replace(/\u0000/g, "").slice(0, limit) : "";
}

function normalizedTags(tags: unknown) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => compact(tag, 50)).filter(Boolean))].slice(0, 8);
}

function tokens(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
}

function searchScore(query: string, note: ManualNote) {
  const haystack = [note.content, note.context, note.project, note.kind, note.tags.join(" ")].filter(Boolean).join(" ").toLowerCase();
  const clean = query.toLowerCase().trim();
  if (!clean) return 0;
  let score = haystack.includes(clean) ? 2 : 0;
  const queryTokens = [...new Set(tokens(clean))];
  if (queryTokens.length) score += queryTokens.filter(token => haystack.includes(token)).length / queryTokens.length;
  return score;
}

export async function listManualNotes() {
  return readJson<ManualNote[]>(notesFile, []);
}

function noteMarkdown(note: ManualNote, timezone: string) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(note.createdAt));
  const labels = [note.project && `项目：${note.project}`, note.kind && `类型：${note.kind}`, note.tags.length && `标签：${note.tags.join("、")}`].filter(Boolean);
  const meta = labels.length ? `\n- ${labels.join(" · ")}` : "";
  const context = note.context ? `\n\n上下文：${note.context}` : "";
  return `### ${time} · ${note.id}\n${note.content}${meta}${context}`;
}

export async function syncManualNoteDate(date: string) {
  const settings = await getSettings();
  if (!settings.feishuWikiNodeToken) return { status: "needs_wiki_target" as const };
  let lark;
  try { lark = await getLarkStatus(settings); }
  catch (error) { return { status: "needs_lark_setup" as const, error: String(error) }; }
  if (!lark.verified) return { status: "needs_auth" as const };

  const notes = (await listManualNotes()).filter(note => note.date === date).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!notes.length) return { status: "empty" as const };
  const index = await readJson<SyncIndex>(syncIndexFile, {});
  const title = `${date} · Worklog Inbox`;
  const markdown = `# ${title}\n\n## 手动留痕\n\n${notes.map(note => noteMarkdown(note, settings.timezone)).join("\n\n")}`;
  const xml = renderDocXml(markdown, { title, header: `ChatGPT / Agent 手动留痕 · ${notes.length} 条` });
  const published = await publishReport(date, xml, settings, await getSecrets(), index[date]?.documentId, "daily", title);
  await updateJson<SyncIndex>(syncIndexFile, {}, current => ({
    ...current,
    [date]: { ...published, updatedAt: new Date().toISOString() },
  }));
  return { status: "synced" as const, ...published, count: notes.length };
}

export async function captureManualNote(input: ManualNoteInput) {
  const content = compact(input.content, 8000);
  if (!content) throw new Error("记录内容不能为空。");
  const settings = await getSettings();
  const now = new Date();
  const note: ManualNote = {
    id: `note-${randomUUID().slice(0, 8)}`,
    date: isoDate(now, settings.timezone),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    content,
    context: compact(input.context, 12000) || undefined,
    project: compact(input.project, 120) || undefined,
    kind: compact(input.kind, 60) || undefined,
    tags: normalizedTags(input.tags),
    source: "chatgpt",
  };
  await updateJson<ManualNote[]>(notesFile, [], notes => [...notes, note]);
  const feishu = await syncManualNoteDate(note.date).catch(error => ({ status: "sync_failed" as const, error: String(error) }));
  return { note, feishu };
}

export async function updateManualNote(id: string, patch: ManualNotePatch) {
  const notes = await updateJson<ManualNote[]>(notesFile, [], notes => notes.map(note => {
    if (note.id !== id) return note;
    const content = patch.content === undefined ? note.content : compact(patch.content, 8000);
    if (!content) throw new Error("记录内容不能为空。");
    return {
      ...note,
      content,
      context: patch.context === undefined ? note.context : compact(patch.context, 12000) || undefined,
      project: patch.project === undefined ? note.project : compact(patch.project, 120) || undefined,
      kind: patch.kind === undefined ? note.kind : compact(patch.kind, 60) || undefined,
      tags: patch.tags === undefined ? note.tags : normalizedTags(patch.tags),
      updatedAt: new Date().toISOString(),
    };
  }));
  const updated = notes.find(note => note.id === id);
  if (!updated) throw new Error(`没有找到记录：${id}`);
  const feishu = await syncManualNoteDate(updated.date).catch(error => ({ status: "sync_failed" as const, error: String(error) }));
  return { note: updated, feishu };
}

export async function searchWorklog(query: string, limit = 10) {
  const clean = compact(query, 500);
  if (!clean) return [];
  const notes = (await listManualNotes())
    .map(note => ({ note, score: searchScore(clean, note) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
    .slice(0, limit)
    .map(item => ({
      id: item.note.id, date: item.note.date, source: "manual" as const, title: item.note.project || item.note.kind || "手动留痕",
      snippet: item.note.content.slice(0, 600), score: Number(item.score.toFixed(3)), note: item.note,
    }));
  const archive = (await searchArchive(clean, limit)).map(item => ({ ...item, source: item.source as "report" | "project" }));
  return [...notes, ...archive].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function beginFeishuAuthorization() {
  const settings = await getSettings();
  try {
    const status = await getLarkStatus(settings);
    if (status.verified) return { status: "ready" as const, user: status.user };
  } catch { /* begin login below */ }
  try {
    const { verificationUrl } = await beginLarkLogin();
    return { status: "authorization_required" as const, verificationUrl };
  } catch (error) {
    return { status: "setup_required" as const, error: String(error) };
  }
}

export async function setFeishuWikiTarget(url: string) {
  const clean = compact(url, 1000);
  if (!clean) throw new Error("请提供飞书知识库父页面链接。");
  const settings = await getSettings();
  const target = await resolveWikiTarget(clean, settings);
  await saveSettings({
    ...settings,
    larkCliPath: target.binary,
    feishuBaseUrl: target.origin,
    feishuWikiNodeToken: target.nodeToken,
  });
  return { status: "ready" as const, title: target.title, spaceId: target.spaceId };
}

export async function syncAllManualNotes(date?: string) {
  const notes = await listManualNotes();
  const dates = date ? [date] : [...new Set(notes.map(note => note.date))].sort();
  const results = [];
  for (const item of dates) results.push({ date: item, ...(await syncManualNoteDate(item)) });
  return results;
}

