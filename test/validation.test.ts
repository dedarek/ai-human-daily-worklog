import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../src/store.js";
import { settingsFromInput, validDate } from "../src/validation.js";

test("dates cannot traverse local storage paths", () => {
  assert.equal(validDate("2026-07-30"), "2026-07-30");
  assert.throws(() => validDate("../../private"), /日期格式/);
  assert.throws(() => validDate("2026-02-31"), /日期格式/);
});

test("settings are normalized and insecure remote HTTP endpoints are rejected", () => {
  const next = settingsFromInput(defaults, { markdownOutputEnabled: false, retentionEnabled: true, evidenceRetentionDays: "45", meetingAudioRetentionDays: "0" });
  assert.equal(next.markdownOutputEnabled, false); assert.equal(next.retentionEnabled, true); assert.equal(next.evidenceRetentionDays, 45); assert.equal(next.meetingAudioRetentionDays, 0);
  assert.throws(() => settingsFromInput(defaults, { llmBaseUrl: "http://remote.example/v1" }), /HTTPS/);
  assert.doesNotThrow(() => settingsFromInput(defaults, { llmBaseUrl: "http://127.0.0.1:11434/v1" }));
  assert.throws(() => settingsFromInput(defaults, { schedule: "invalid cron" }), /定时规则/);
});
