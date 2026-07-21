import { test } from "node:test";
import assert from "node:assert/strict";
import { isMeetingTitle, isMeetingWindow, hasMeetingSignal } from "../src/meetingDetect.js";

test("识别中文“……中的会议”标题（旧规则漏配的用例）", () => {
  assert.equal(isMeetingTitle("AI安全-Guard模型 中的会议"), true);
  assert.equal(isMeetingWindow(["Chat | Microsoft Teams", "AI安全-Guard模型 中的会议"]), true);
});

test("识别常见会议/通话标题", () => {
  assert.equal(isMeetingTitle("每周同步会议"), true);
  assert.equal(isMeetingTitle("与张三的通话"), true);
  assert.equal(isMeetingTitle("Weekly Sync Meeting"), true);
  assert.equal(isMeetingTitle("Huddle"), true);
});

test("排除聊天/日历/通话记录等非会议视图", () => {
  assert.equal(isMeetingTitle("Chat | Microsoft Teams"), false);
  assert.equal(isMeetingTitle("聊天 | Microsoft Teams"), false);
  assert.equal(isMeetingTitle("Calendar | Microsoft Teams"), false);
  assert.equal(isMeetingTitle("通话记录"), false);
  assert.equal(isMeetingTitle("Microsoft Teams"), false);
  assert.equal(isMeetingTitle(""), false);
});

test("hasMeetingSignal 任一信号即命中", () => {
  assert.equal(hasMeetingSignal({ audioRunning: false, meetingWindow: false, callHelper: false }), false);
  assert.equal(hasMeetingSignal({ audioRunning: true, meetingWindow: false, callHelper: false }), true);
  assert.equal(hasMeetingSignal({ audioRunning: false, meetingWindow: false, callHelper: true }), true);
});
