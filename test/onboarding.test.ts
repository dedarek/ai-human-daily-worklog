import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("Teams screen permission does not block otherwise complete onboarding", async () => {
  const source = await readFile(join(process.cwd(), "src", "onboarding.ts"), "utf8");
  assert.match(source, /complete: Boolean\(secrets\.llmApiKey && meetingReady && destinationReady\)/);
  assert.doesNotMatch(source, /complete: permissionsReady/);
});
