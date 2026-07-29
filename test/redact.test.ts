import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.js";

test("redact removes common credentials", () => {
  const value = redact("curl https://example.test -H 'Authorization: Bearer abc.def.ghi' --api-key=sk-test_123456789");
  assert.match(value, /\[REDACTED\]/);
  assert.match(value, /--api-key=\[REDACTED\]/);
  assert.doesNotMatch(value, /abc\.def\.ghi|sk-test_123456789/);
});

test("redact replaces configured sensitive terms", () => {
  assert.equal(redact("项目 Alpha 的客户 Acme 已完成", ["Alpha", "Acme"]), "项目 [REDACTED_TERM] 的客户 [REDACTED_TERM] 已完成");
});
