const $ = selector => document.querySelector(selector);
const form = $("#settings");
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function json(url, options) {
  const response = await fetch(url, options); const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败"); return body;
}

async function loadRuns() {
  const runs = await json("/api/runs");
  $("#runs").innerHTML = runs.length ? runs.map(run => {
    const label = run.kind === "weekly" ? `周报 ${run.start} 至 ${run.end}` : run.kind === "monthly" ? `月报 ${run.start?.slice(0, 7) || ""}` : run.date || "—";
    const url = run.url || run.document?.url;
    const result = run.status === "success" ? (run.sourceDays ? `汇总 ${run.sourceDays} 个工作日` : "已生成") : "生成失败";
    return `<article class="run ${escapeHtml(run.status)}"><div><b>${escapeHtml(label)}</b><small>${new Date(run.at).toLocaleString("zh-CN")}</small></div><span>${result}</span>${url ? `<a target="_blank" href="${escapeHtml(url)}">打开文档 ↗</a>` : run.error ? `<em>${escapeHtml(run.error)}</em>` : ""}</article>`;
  }).join("") : '<p class="hint">还没有生成记录。</p>';
}

async function load() {
  const [settings, status, setup] = await Promise.all([json("/api/settings"), json("/api/status"), json("/api/setup/status")]);
  for (const [key, value] of Object.entries(settings)) {
    const element = form.elements[key]; if (element) element.value = key === "ignoredProcesses" ? value.join("\n") : value || "";
  }
  $("#state").textContent = setup.ready ? "配置完整，后台正在运行" : "后台运行中，初始化尚未完成";
  $("#meta").textContent = `工作日 18:00 日报 · 周一 08:00 周报 · 每月 1 日 08:10 月报（${status.timezone}）`;
  const lark = setup.lark;
  $("#larkStatus").innerHTML = lark.installed
    ? `<b>已连接：${escapeHtml(lark.user?.userName || lark.identity || "飞书用户")}</b><small>CLI ${lark.verified ? "认证有效" : "需要重新授权"} · ${escapeHtml(lark.binary)}</small>`
    : `<b>尚未连接飞书 CLI</b><small>${escapeHtml(lark.error || "请按安装指南完成配置与登录")}</small>`;
  await loadRuns();
}

form.addEventListener("submit", async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(form));
  data.ignoredProcesses = data.ignoredProcesses.split("\n").map(value => value.trim()).filter(Boolean);
  try { await json("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); $("#notice").textContent = "配置已保存。"; await load(); }
  catch (error) { $("#notice").textContent = error.message; }
});

$("#run").addEventListener("click", async () => {
  $("#notice").textContent = "正在采集、生成并通过飞书 CLI 写入，请稍候…";
  try { const output = await json("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }); $("#notice").innerHTML = `已完成：${output.events} 条活动\n飞书文档：<a href="${escapeHtml(output.url)}" target="_blank">${escapeHtml(output.title)}</a>`; await loadRuns(); }
  catch (error) { $("#notice").textContent = error.message; }
});

$("#bindWiki").addEventListener("click", async () => {
  try { const output = await json("/api/wiki-target", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: $("#wikiUrl").value }) }); $("#notice").textContent = `已用飞书用户身份绑定知识库：${output.title}`; await load(); }
  catch (error) { $("#notice").textContent = error.message; }
});

$("#refresh").addEventListener("click", () => loadRuns().catch(error => $("#notice").textContent = error.message));
load().catch(error => $("#notice").textContent = error.message);
