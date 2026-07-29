import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyXml, summaryXml, renderDocXml } from "../src/render.js";

const daily = `# 2026-07-21 工作日志

## 工作概览

今天推进了 A 项目与 B 项目。

## 项目进展与产出

### A 项目

完成了核心模块。

### B 项目

调研阶段。

## 关键问题与判断

当天留痕未体现明确的关键问题或决策。

## 当前状态

A 项目：已完成；核心模块上线。B 项目：进行中；仍在调研。C 项目：受阻；等待依赖。`;

test("dailyXml 概览渲染为高亮框", () => {
  const xml = dailyXml(daily, { date: "2026-07-21", sourceSummary: "Terminal: 5 条" });
  assert.match(xml, /<callout emoji="💡"[^>]*><p>今天推进了 A 项目与 B 项目。<\/p><\/callout>/);
});

test("dailyXml 头部信息框含日期与来源", () => {
  const xml = dailyXml(daily, { date: "2026-07-21", sourceSummary: "Terminal: 5 条" });
  assert.match(xml, /日期：2026-07-21/);
  assert.match(xml, /留痕来源：Terminal: 5 条/);
});

test("dailyXml 项目段保留 h3 与段落", () => {
  const xml = dailyXml(daily, { date: "2026-07-21" });
  assert.match(xml, /<h3>A 项目<\/h3><p>完成了核心模块。<\/p>/);
});

test("dailyXml 当前状态渲染为彩色表格", () => {
  const xml = dailyXml(daily, { date: "2026-07-21" });
  assert.match(xml, /<table>/);
  assert.match(xml, /<span text-color="green">✅ 已完成<\/span>/);
  assert.match(xml, /<span text-color="blue">🔵 进行中<\/span>/);
  assert.match(xml, /<span text-color="red">🔴 受阻<\/span>/);
  assert.match(xml, /<td>核心模块上线<\/td>/);
});

test("XML 特殊字符转义", () => {
  const md = `# 标题

## 工作概览

比较 a < b 且 x & y 的关系。`;
  const xml = renderDocXml(md, { calloutHeadings: ["工作概览"] });
  assert.match(xml, /a &lt; b 且 x &amp; y/);
  assert.doesNotMatch(xml, /a < b/);
});

test("summaryXml 概览与状态", () => {
  const md = `# 2026 年周报

## 本期概览

本周聚焦 X。

## 本期状态

X：进行中；持续开发。Y：已验证；测试通过。`;
  const xml = summaryXml(md, { label: "2026-07-13~2026-07-17" });
  assert.match(xml, /周期：2026-07-13~2026-07-17/);
  assert.match(xml, /<callout emoji="💡"/);
  assert.match(xml, /<span text-color="green">✅ 已验证<\/span>/);
});
