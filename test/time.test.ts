import { test } from "node:test";
import assert from "node:assert/strict";
import { dateAdd, workdays, previousMonth, isoDate, inHourWindow } from "../src/time.js";
import { previousWorkWeek } from "../src/scheduler.js";

test("dateAdd 跨月与跨年", () => {
  assert.equal(dateAdd("2024-02-28", 1), "2024-02-29");
  assert.equal(dateAdd("2024-12-31", 1), "2025-01-01");
  assert.equal(dateAdd("2024-03-01", -1), "2024-02-29");
});

test("workdays 仅返回周一到周五", () => {
  // 2024-06-03 周一 ~ 2024-06-09 周日
  assert.deepEqual(workdays("2024-06-03", "2024-06-09"), ["2024-06-03", "2024-06-04", "2024-06-05", "2024-06-06", "2024-06-07"]);
});

test("workdays 单个周末返回空", () => {
  assert.deepEqual(workdays("2024-06-08", "2024-06-09"), []);
});

test("previousMonth 计算上月起止", () => {
  assert.deepEqual(previousMonth("2024-03-15"), { start: "2024-02-01", end: "2024-02-29", month: "2024-02" });
  assert.deepEqual(previousMonth("2024-01-10"), { start: "2023-12-01", end: "2023-12-31", month: "2023-12" });
});

test("isoDate 按时区格式化", () => {
  const d = new Date("2024-06-05T20:00:00Z");
  assert.equal(isoDate(d, "Asia/Shanghai"), "2024-06-06"); // +8 跨天
  assert.equal(isoDate(d, "UTC"), "2024-06-05");
});

test("inHourWindow 判定工作时间窗", () => {
  const at = (h: number, m = 0) => `2024-06-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`;
  assert.equal(inHourWindow(at(8, 0), "Asia/Shanghai", 8, 18), true);
  assert.equal(inHourWindow(at(18, 0), "Asia/Shanghai", 8, 18), true);
  assert.equal(inHourWindow(at(7, 59), "Asia/Shanghai", 8, 18), false);
  assert.equal(inHourWindow(at(18, 1), "Asia/Shanghai", 8, 18), false);
  assert.equal(inHourWindow("not-a-date", "Asia/Shanghai", 8, 18), false);
});

test("previousWorkWeek 在周中和周一都指向上周一到周五", () => {
  assert.deepEqual(previousWorkWeek("2024-06-05", "Asia/Shanghai"), { start: "2024-05-27", end: "2024-05-31" });
  assert.deepEqual(previousWorkWeek("2024-06-03", "Asia/Shanghai"), { start: "2024-05-27", end: "2024-05-31" });
});
