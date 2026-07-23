import { test } from "node:test";
import assert from "node:assert/strict";
import { isMeetingTitle, isMeetingWindow, hasMeetingSignal, transcriptQuality } from "../src/meetingDetect.js";

test("识别中文“……中的会议”标题（旧规则漏配的用例）", () => {
  assert.equal(isMeetingTitle("AI安全-Guard模型 中的会议"), true);
  assert.equal(isMeetingWindow(["Chat | Microsoft Teams", "AI安全-Guard模型 中的会议"]), true);
});

test("识别常见会议/通话标题", () => {
  assert.equal(isMeetingTitle("每周同步会议"), true);
  assert.equal(isMeetingTitle("研发周例会 | Microsoft Teams"), true);
  assert.equal(isMeetingTitle("安全方案评审会"), true);
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

test("自动开始只接受真实会议窗口，不能被采集器音频反向触发", () => {
  assert.equal(hasMeetingSignal({ audioRunning: false, meetingWindow: false, callHelper: false }), false);
  assert.equal(hasMeetingSignal({ audioRunning: true, meetingWindow: false, callHelper: false }), false);
  assert.equal(hasMeetingSignal({ audioRunning: false, meetingWindow: false, callHelper: true }), false);
  assert.equal(hasMeetingSignal({ audioRunning: false, meetingWindow: true, callHelper: false }), true);
});

test("过滤重复占位词与识别噪声", () => {
  assert.equal(transcriptQuality("you ".repeat(100)).valid, false);
  assert.equal(transcriptQuality("嗯 啊 哦 呃 ".repeat(30)).valid, false);
  assert.equal(transcriptQuality("我们确认本周先完成接口联调，数据口径由产品负责人今天补充，开发完成后安排一次验收。另一个问题是权限申请尚未通过，需要继续跟进。" ).valid, true);
});
