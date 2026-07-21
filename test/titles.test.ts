import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyTitle, weeklyTitle, monthlyTitle, meetingTitle } from "../src/titles.js";

test("dailyTitle", () => {
  assert.equal(dailyTitle("2026-07-21"), "【日报】2026-07-21");
});

test("weeklyTitle", () => {
  assert.equal(weeklyTitle("2026-07-13", "2026-07-17"), "【周报】2026-07-13~2026-07-17");
});

test("monthlyTitle 取前 7 位", () => {
  assert.equal(monthlyTitle("2026-07-01"), "【月报】2026-07");
  assert.equal(monthlyTitle("2026-07"), "【月报】2026-07");
});

test("meetingTitle 带主题", () => {
  assert.equal(meetingTitle("2026-07-21", "15:30", "AI安全"), "【会议纪要】2026-07-21 15:30 AI安全");
});

test("meetingTitle 无主题", () => {
  assert.equal(meetingTitle("2026-07-21", "15:30"), "【会议纪要】2026-07-21 15:30");
  assert.equal(meetingTitle("2026-07-21", "15:30", "  "), "【会议纪要】2026-07-21 15:30");
});
