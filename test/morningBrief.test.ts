import test from "node:test";
import assert from "node:assert/strict";
import { previousWorkdays } from "../src/morningBrief.js";

test("morning brief looks back across weekends", () => {
  assert.deepEqual(previousWorkdays("2026-08-03", 3), ["2026-07-31", "2026-07-30", "2026-07-29"]);
});
