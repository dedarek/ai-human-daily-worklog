import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, readJson } from "./jsonStore.js";
import { redact } from "./redact.js";
import { dataDir, logRun } from "./store.js";
import type { Settings } from "./types.js";

const VERSION = 2;
const markerFile = join(dataDir, "privacy-migration.json");
const roots = ["evidence", "operations", "reports", "drafts", "briefs", "graph", "traces", "exports"];
const topFiles = ["meetings.json", "runs.jsonl", "published.json", "wiki-index.json"];
const textExtensions = /\.(?:json|jsonl|md|txt)$/i;

async function textFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const info = await stat(path);
  if (info.isFile()) return textExtensions.test(path) && info.size <= 64 * 1024 * 1024 ? [path] : [];
  const out: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(...await textFiles(child));
    else if (entry.isFile() && textExtensions.test(entry.name)) {
      const childInfo = await stat(child); if (childInfo.size <= 64 * 1024 * 1024) out.push(child);
    }
  }
  return out;
}

export async function scrubStoredSensitiveData(settings: Settings, force = false) {
  const previous = await readJson<{ version?: number }>(markerFile, {});
  if (!force && previous.version === VERSION) return { scanned: 0, changed: 0, version: VERSION };
  const files = (await Promise.all([...roots.map(root => textFiles(join(dataDir, root))), ...topFiles.map(file => textFiles(join(dataDir, file)))])).flat();
  let changed = 0;
  for (const file of files) {
    const original = await readFile(file, "utf8");
    const safe = redact(original, settings.redactionTerms);
    if (safe !== original) { await atomicWriteFile(file, safe); changed++; }
  }
  await atomicWriteFile(markerFile, JSON.stringify({ version: VERSION, completedAt: new Date().toISOString(), scanned: files.length, changed }, null, 2));
  if (changed) await logRun({ status: "privacy_scrub", scanned: files.length, changed, version: VERSION });
  return { scanned: files.length, changed, version: VERSION };
}
