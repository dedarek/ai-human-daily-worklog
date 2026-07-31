import assert from "node:assert/strict";
import test from "node:test";
import { cleanPrompt } from "../src/agentLogs.js";

test("agent logs drop task notifications and stopped-agent metadata", () => {
  assert.equal(cleanPrompt("<task-notification><task-id>abc</task-id><status>stopped</status></task-notification>"), "");
  assert.equal(cleanPrompt('Background agent "/code-review" was stopped by the user.'), "");
  assert.equal(cleanPrompt("请检查今天的会议记录"), "请检查今天的会议记录");
});
