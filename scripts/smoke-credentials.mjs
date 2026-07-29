import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKLOG_DATA_DIR ||= await mkdtemp(join(tmpdir(), "worklog-credentials-"));
if (process.platform === "darwin") {
  console.log("✓ darwin credential smoke skipped: never mutate a developer's real Keychain from CI/local tests");
  process.exit(0);
}
const { saveSecrets, getSecrets } = await import("../dist/store.js");
const expected = `worklog-test-${process.pid}-${Date.now()}`;
await saveSecrets({ llmApiKey: expected });
assert.equal((await getSecrets()).llmApiKey, expected);
console.log(`✓ ${process.platform} credential round trip`);
