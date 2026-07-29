import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { dataDir } from "./store.js";
import type { Settings } from "./types.js";
import { atomicWriteFile } from "./jsonStore.js";

export async function writeMarkdownExport(filename: string, content: string, settings: Settings) {
  if (!settings.markdownOutputEnabled) return "";
  const root = settings.markdownOutputDir?.trim() || join(dataDir, "exports");
  const target = isAbsolute(root) ? join(root, filename) : join(dataDir, root, filename);
  await mkdir(dirname(target), { recursive: true });
  await atomicWriteFile(target, content);
  return target;
}
