import test from "node:test";
import assert from "node:assert/strict";
import { applyCorrectionPreferences, buildReportTrace, buildWorkGraph, detectEvidenceGaps, emptyPreferences, projectHint } from "../src/workGraph.js";
import type { Activity } from "../src/types.js";

const activities: Activity[] = [
  { timestamp: "2026-07-30T01:00:00Z", process: "Codex", message: "提问：为 worklog 增加 Windows 安装器", evidenceId: "e1" },
  { timestamp: "2026-07-30T01:10:00Z", process: "Terminal", message: "命令：npm test（目录：/Users/demo/projects/worklog）", evidenceId: "e2" },
  { timestamp: "2026-07-30T01:20:00Z", process: "Terminal", message: "命令：git commit -m release（目录：/Users/demo/projects/worklog）测试通过", evidenceId: "e3" },
];

test("project hint extracts repository from cwd", () => {
  assert.equal(projectHint(activities[1]), "worklog");
});

test("work graph connects intent, execution and verified artifacts", async () => {
  const graph = await buildWorkGraph("2026-07-30", activities, undefined, false);
  const project = graph.projects.find(item => item.name === "worklog");
  assert.ok(project);
  assert.equal(project.chains.some(item => item.intent?.evidenceId === "e1"), true);
  assert.equal(project.artifacts.some(item => item.type === "commit" && item.verified), true);
  assert.equal(project.chains.some(item => item.status === "verified"), true);
});

test("report trace keeps claims linked to local evidence", async () => {
  const graph = await buildWorkGraph("2026-07-30", activities, undefined, false);
  const trace = buildReportTrace("2026-07-30", "# 日报\n\n## 项目进展\n\n完成 Windows 安装器测试并提交代码。", activities, graph);
  assert.equal(trace.claims.length, 1);
  assert.ok(trace.claims[0].evidenceIds.length > 0);
  assert.ok(trace.claims[0].confidence > 0.45);
});

test("gap detector asks no more than two focused questions", async () => {
  const unfinished = activities.slice(0, 2);
  const graph = await buildWorkGraph("2026-07-30", unfinished, undefined, false);
  assert.ok(detectEvidenceGaps(graph).length <= 2);
});

test("accepted corrections teach aliases, exclusions and section length locally", () => {
  const learned = applyCorrectionPreferences(
    emptyPreferences(),
    "# 日报\n\n## 项目进展\n\n### 临时项目\n\n无价值内容。\n\n### Worklog\n\n完成构建。",
    "# 日报\n\n## 项目进展\n\n### Worklog\n\n完成构建并验证安装。",
    { "mac-worklog-feishu": "Worklog" },
  );
  assert.equal(learned.projectAliases["mac-worklog-feishu"], "Worklog");
  assert.ok(learned.ignoredPatterns.includes("临时项目"));
  assert.ok((learned.sectionTargets["项目进展"] || 0) > 0);
});
