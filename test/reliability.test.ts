import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../src/redact.js";
import { catchUpEligible } from "../src/scheduler.js";
import { meetingAutoStartThreshold } from "../src/teamsMeeting.js";

test("redaction covers pasted Feishu credentials and colon-delimited model keys", () => {
  const lark = redact("cli_abcdefghijklmno AbCdEfGhIjKlMnOpQrStUvWxYz123456");
  const model = redact("APIKey: abcdef0123456789abcdef0123456789:QWERTYuiopASDFGHjklZXCVBnm123456");
  assert.equal(lark, "cli_abcdefghijklmno [REDACTED]");
  assert.doesNotMatch(model, /QWERTYuiop/);
});

test("automatic Teams detection is conservative without an explicit meeting window", () => {
  assert.equal(meetingAutoStartThreshold(true), 3);
  assert.equal(meetingAutoStartThreshold(false), 8);
});

test("failed catch-up work cools down for six hours", () => {
  const now = Date.parse("2026-07-30T12:00:00Z");
  assert.equal(catchUpEligible("2026-07-30T08:00:01Z", now), false);
  assert.equal(catchUpEligible("2026-07-30T05:59:59Z", now), true);
});
