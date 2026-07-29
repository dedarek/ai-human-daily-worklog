import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMarkdownExport } from "../src/markdown.js";

test("writeMarkdownExport writes to a configured local destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worklog-export-"));
  const settings = { markdownOutputEnabled: true, markdownOutputDir: dir } as any;
  const target = await writeMarkdownExport("daily-test.md", "# Worklog\n", settings);
  assert.equal(await readFile(target, "utf8"), "# Worklog\n");
});

test("writeMarkdownExport can be disabled", async () => {
  const target = await writeMarkdownExport("disabled.md", "ignored", { markdownOutputEnabled: false } as any);
  assert.equal(target, "");
});
