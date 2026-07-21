// 把本系统生成的朴素 Markdown 报告确定性地渲染为飞书文档 XML（docs +update --doc-format xml）。
// WHY：LLM 只负责产出结构化文本并压制虚构，排版美化交给这里，避免让模型手写易错的 XML；
// 本地 .md 存档与周月报输入仍用纯 Markdown，故富化只作用于飞书发布这一路。

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 状态词 → 颜色与标记。已完成类绿色，进行中蓝色，受阻红色，待确认橙色。
const STATUS_STYLES: Array<{ words: string[]; color: string; emoji: string }> = [
  { words: ["已完成", "已验证", "已发布", "已处理", "已上线", "已完成并验证"], color: "green", emoji: "✅" },
  { words: ["进行中", "推进中"], color: "blue", emoji: "🔵" },
  { words: ["受阻", "阻塞", "失败"], color: "red", emoji: "🔴" },
  { words: ["待确认", "待定", "未开始", "已暂停", "待跟进"], color: "orange", emoji: "🟡" },
];

function statusStyle(word: string) {
  for (const style of STATUS_STYLES) if (style.words.some(w => word.startsWith(w) || word.includes(w))) return style;
  return { color: "gray", emoji: "⚪" };
}

type Section = { heading: string; body: string };

function splitSections(markdown: string): { title: string; sections: Section[] } {
  let title = "";
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of markdown.split("\n")) {
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);
    if (h2) { current = { heading: h2[1].trim(), body: "" }; sections.push(current); }
    else if (h1) { title = h1[1].trim(); }
    else if (current) { current.body += line + "\n"; }
  }
  return { title, sections };
}

// 通用正文渲染：识别 ### 小标题、- 列表、空行分段，其余合并为段落。
function bodyToXml(body: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${esc(para.join(""))}</p>`); para = []; } };
  const flushList = () => { if (list.length) { out.push(`<ul>${list.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`); list = []; } };
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const h3 = line.match(/^###\s+(.+)/);
    const item = line.match(/^[-*]\s+(.+)/);
    if (h3) { flushPara(); flushList(); out.push(`<h3>${esc(h3[1].trim())}</h3>`); }
    else if (item) { flushPara(); list.push(item[1].trim()); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return out.join("");
}

// 状态段解析为表格行。兼容两种格式：
//   新：「名称：状态词；说明。」  旧：「名称：长描述。」（无独立状态词）
// 项目间以「。」分隔，项目内首个「：」分名称与其余；仅当其余以已知状态词开头才识别状态。
const KNOWN_STATUS = STATUS_STYLES.flatMap(s => s.words);

function parseStatusItems(body: string): Array<{ name: string; status: string; detail: string }> {
  const text = body.replace(/\n+/g, " ").trim();
  if (!text) return [];
  const items: Array<{ name: string; status: string; detail: string }> = [];
  for (const chunk of text.split(/。/).map(c => c.trim()).filter(Boolean)) {
    const idx = chunk.search(/[：:]/);
    if (idx < 0) continue;
    const name = chunk.slice(0, idx).trim();
    if (!name || name.length > 20) continue;
    const rest = chunk.slice(idx + 1).trim();
    const head = rest.split(/[；;]/)[0].trim();
    const isStatus = head.length <= 6 && KNOWN_STATUS.some(w => head.startsWith(w));
    if (isStatus) items.push({ name, status: head, detail: rest.slice(head.length).replace(/^[；;，,、：:\s]+/, "").trim() });
    else items.push({ name, status: "", detail: rest });
  }
  return items;
}

function statusTableXml(body: string): string {
  const items = parseStatusItems(body);
  // 无法结构化（少于两项）或全无状态词时，回退为普通段落，避免无意义表格。
  if (items.length < 2 || !items.some(item => item.status)) return bodyToXml(body);
  const rows = items.map(item => {
    const style = statusStyle(item.status);
    const badge = item.status ? `<span text-color="${style.color}">${style.emoji} ${esc(item.status)}</span>` : "";
    return `<tr><td>${esc(item.name)}</td><td>${badge}</td><td>${esc(item.detail)}</td></tr>`;
  }).join("");
  return `<table><colgroup><col width="180"/><col width="90"/><col width="360"/></colgroup>` +
    `<thead><tr><th background-color="light-gray">项目</th><th background-color="light-gray">状态</th><th background-color="light-gray">说明</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

function calloutXml(body: string, emoji: string, bg: string, border: string): string {
  const text = body.replace(/\n+/g, "").trim();
  return `<callout emoji="${emoji}" background-color="${bg}" border-color="${border}"><p>${esc(text)}</p></callout>`;
}

function checkboxXml(body: string): string {
  const lines = body.split("\n").map(l => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
  if (!lines.length) return bodyToXml(body);
  // 明确「无」类占位不渲染成待办勾选框。
  if (lines.length === 1 && /^(无|暂无|未明确|无待办)/.test(lines[0])) return bodyToXml(body);
  return lines.map(line => `<checkbox done="false">${esc(line)}</checkbox>`).join("");
}

export type RenderOpts = {
  title?: string;
  header?: string;
  calloutHeadings?: string[];
  tableHeadings?: string[];
  checkboxHeadings?: string[];
};

export function renderDocXml(markdown: string, opts: RenderOpts = {}): string {
  const { title, sections } = splitSections(markdown);
  const parts: string[] = [];
  parts.push(`<title>${esc(opts.title || title || "文档")}</title>`);
  if (opts.header) parts.push(calloutXml(opts.header, "📌", "light-blue", "blue"));
  const isCallout = new Set(opts.calloutHeadings ?? []);
  const isTable = new Set(opts.tableHeadings ?? []);
  const isCheckbox = new Set(opts.checkboxHeadings ?? []);
  for (const section of sections) {
    parts.push(`<h2>${esc(section.heading)}</h2>`);
    if (isCallout.has(section.heading)) parts.push(calloutXml(section.body, "💡", "light-yellow", "yellow"));
    else if (isTable.has(section.heading)) parts.push(statusTableXml(section.body));
    else if (isCheckbox.has(section.heading)) parts.push(checkboxXml(section.body));
    else parts.push(bodyToXml(section.body));
  }
  return parts.join("\n");
}

export function dailyXml(markdown: string, meta: { date: string; sourceSummary?: string }): string {
  const source = (meta.sourceSummary ?? "").slice(0, 200);
  const header = `日期：${meta.date}${source ? `　·　留痕来源：${source}` : ""}`;
  return renderDocXml(markdown, {
    header,
    calloutHeadings: ["工作概览"],
    tableHeadings: ["当前状态"],
  });
}

export function summaryXml(markdown: string, meta: { label: string }): string {
  return renderDocXml(markdown, {
    header: `周期：${meta.label}`,
    calloutHeadings: ["本期概览"],
    tableHeadings: ["本期状态"],
  });
}

export function meetingXml(markdown: string): string {
  return renderDocXml(markdown, {
    calloutHeadings: ["会议概览"],
    checkboxHeadings: ["待办事项"],
  });
}
