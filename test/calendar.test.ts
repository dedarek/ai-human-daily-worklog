import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarKey } from "../src/feishu.js";

test("calendarKey ISO 周与月归类", () => {
  const jan4 = calendarKey("2024-01-04"); // ISO 周一定落在第 1 周
  assert.equal(jan4.month, "2024-01");
  assert.equal(jan4.week, "2024-W01");

  const jun5 = calendarKey("2024-06-05");
  assert.equal(jun5.month, "2024-06");
  assert.match(jun5.week, /^2024-W\d{2}$/);
  assert.match(jun5.weekLabel, /^2024 年第 \d+ 周$/);
});
