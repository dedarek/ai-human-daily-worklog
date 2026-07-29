import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, updateJson } from "../src/jsonStore.js";

test("missing JSON uses fallback but corrupted JSON is never silently replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklog-json-")); const path = join(directory, "state.json");
  assert.deepEqual(await readJson(path, { value: 0 }), { value: 0 });
  await writeFile(path, "{broken", { mode: 0o600 });
  await assert.rejects(() => updateJson(path, { value: 0 }, state => ({ value: state.value + 1 })), /已损坏/);
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("concurrent JSON updates are serialized without lost writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklog-json-")); const path = join(directory, "counter.json");
  await Promise.all(Array.from({ length: 20 }, () => updateJson(path, { value: 0 }, async state => ({ value: state.value + 1 }))));
  assert.equal((await readJson(path, { value: 0 })).value, 20);
});
