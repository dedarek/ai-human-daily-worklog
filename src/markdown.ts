import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { dataDir } from "./store.js";
import type { Settings } from "./types.js";

export async function writeMarkdownExport(filename: string, content: string, settings: Settings) {
  if (!settings.markdownOutputEnabled) return "";
  const root = settings.markdownOutputDir?.trim() || join(dataDir, "exports");
  const target = isAbsolute(root) ? join(root, filename) : join(dataDir, root, filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { mode: 0o600 });
  return target;
}
