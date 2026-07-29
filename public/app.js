const $ = selector => document.querySelector(selector);
const form = $("#settings");
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const today = () => new Date().toLocaleDateString("en-CA");
let currentDraft = null;
let auditEvidence = new Map();

async function json(url, options) {
  const response = await fetch(url, options); const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败"); return body;
}

const confidenceLabel = value => value >= .75 ? "高可信" : value >= .5 ? "中可信" : "需确认";
const confidenceClass = value => value >= .75 ? "high" : value >= .5 ? "medium" : "low";
const artifactNames = { commit: "提交", pull_request: "PR", release: "发布", document: "文档", file: "文件", build: "构建", test: "测试", deployment: "部署", decision: "决策" };

function initializeFrame() {
  const now = new Date();
  const month = new Intl.DateTimeFormat("en", { month: "short" }).format(now).toUpperCase();
  $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(now);
  $("#dateDay").textContent = String(now.getDate()).padStart(2, "0");
  $("#dateMonth").textContent = `${month} ${now.getFullYear()}`;
  $("#dateWeekday").textContent = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);

  const links = [...document.querySelectorAll(".primary-nav a")];
  const sections = links.map(link => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    links.forEach(link => link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`));
  }, { rootMargin: "-15% 0px -70%", threshold: [0, .15, .5] });
  sections.forEach(section => observer.observe(section));
}

function markPopulated(selector, populated) {
  const element = $(selector);
  element.classList.toggle("empty-state", !populated);
  element.classList.remove("loading-state");
}

function scheduleClock(value) {
  const [minute, hour] = String(value || "").trim().split(/\s+/).map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute)
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : "未设置";
}

function renderGraph(graph) {
  const projects = graph?.projects || [];
  const artifacts = projects.reduce((total, project) => total + (project.artifacts?.length || 0), 0);
  $("#metricProjects").textContent = projects.length;
  $("#metricArtifacts").textContent = artifacts;
  $("#workGraph").innerHTML = projects.length ? projects.map(project => `<article class="project-card">
    <div class="project-head"><h3>${escapeHtml(project.name)}</h3><small>${project.evidenceIds.length} 条证据 · ${project.artifacts.length} 个产物</small></div>
    <div class="chains">${project.chains.slice(0, 8).map(chain => `<div class="chain">
      <div class="chain-title"><b>${escapeHtml(chain.title)}</b><span class="confidence ${confidenceClass(chain.confidence)}">${confidenceLabel(chain.confidence)}</span></div>
      <div class="chain-flow"><span>意图</span><i>→</i><span>${chain.steps.length} 个执行节点</span><i>→</i><span>${chain.artifacts.length ? `${chain.artifacts.length} 个产物` : "结果待确认"}</span></div>
      ${chain.artifacts.length ? `<div class="artifacts">${chain.artifacts.map(item => `<span title="${escapeHtml(item.title)}">${artifactNames[item.type] || item.type}${item.verified ? " ✓" : ""}</span>`).join("")}</div>` : ""}
      <p>${escapeHtml(chain.outcome)}</p>
    </div>`).join("")}</div>
  </article>`).join("") : '<p class="hint">今天还没有足够的工作证据来构建项目图谱。</p>';
  markPopulated("#workGraph", projects.length > 0);
}

async function loadGraph() {
  renderGraph(await json(`/api/work-graph?date=${encodeURIComponent(today())}`));
}

function collectGapAnswers() {
  return Object.fromEntries([...document.querySelectorAll("[data-gap-answer]")].map(input => [input.dataset.gapAnswer, input.value.trim()]).filter(([, value]) => value));
}

function renderTrace(draft) {
  const claims = draft?.trace?.claims || [];
  $("#trace").innerHTML = claims.length ? `<h3>报告证据追溯</h3>${claims.map(claim => {
    const evidence = claim.evidenceIds.map(id => auditEvidence.get(id)).filter(Boolean);
    return `<details class="claim ${confidenceClass(claim.confidence)}"><summary><span>${escapeHtml(claim.text)}</span><b>${confidenceLabel(claim.confidence)} · ${Math.round(claim.confidence * 100)}%</b></summary>
      <div class="claim-evidence">${evidence.length ? evidence.map(item => `<p><code>${escapeHtml(item.evidenceId)}</code> ${new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · ${escapeHtml(item.process)}<br/>${escapeHtml(item.message)}</p>`).join("") : `<p>关联证据：${escapeHtml(claim.evidenceIds.join("、") || "尚未建立直接关联")}</p>`}</div>
    </details>`;
  }).join("")}` : '<p class="hint">这份草稿还没有可显示的证据映射。</p>';
}

function renderDraft(draft) {
  currentDraft = draft;
  $("#draftEditor").disabled = false;
  $("#draftEditor").value = draft.editedReport || "";
  $("#draftSave").disabled = false;
  $("#draftRegenerate").disabled = false;
  $("#draftPublish").disabled = false;
  $("#draftState").textContent = `${draft.status === "published" ? "已发布" : "待发布"} · v${draft.version}`;
  $("#draftState").className = `status-stamp ${draft.status}`;
  $("#metricDraft").textContent = draft.status === "published" ? "已发布" : `草稿 v${draft.version}`;
  $("#draftVersion").textContent = `初稿生成于 ${new Date(draft.createdAt).toLocaleString("zh-CN")}；当前版本 v${draft.version}，更新于 ${new Date(draft.updatedAt).toLocaleString("zh-CN")}。`;
  $("#draftOriginal").textContent = draft.originalReport || "";
  $("#draftCurrent").textContent = draft.editedReport || "";
  $("#gapQuestions").innerHTML = draft.gaps?.length ? `<h3>发布前只确认这 ${draft.gaps.length} 个证据缺口</h3>${draft.gaps.map(gap => `<label class="gap-question"><b>${escapeHtml(gap.question)}</b><small>${escapeHtml(gap.reason)}</small><input data-gap-answer="${escapeHtml(gap.id)}" value="${escapeHtml(draft.answers?.[gap.id] || "")}" placeholder="可选；一句话回答即可"/></label>`).join("")}` : '<p class="ready-note">没有检测到需要你补充的关键证据缺口。</p>';
  renderGraph(draft.graph);
  renderTrace(draft);
}

async function loadDraft() {
  try { renderDraft(await json(`/api/draft?date=${encodeURIComponent(today())}`)); }
  catch (error) {
    if (!String(error.message).includes("尚无预览草稿")) throw error;
  }
}

async function generateDraft(force = true) {
  $("#notice").textContent = "正在整理项目、产物和证据，并生成日报预览…";
  const draft = await json("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: today(), force, answers: collectGapAnswers() }) });
  renderDraft(draft); $("#notice").textContent = `日报预览已生成，共使用 ${draft.events} 条有效工作证据。发布前可以直接修改。`;
}

async function saveDraft(regenerate = false) {
  if (!currentDraft) return generateDraft(true);
  const from = $("#aliasFrom").value.trim(), to = $("#aliasTo").value.trim();
  const aliases = from && to ? { [from]: to } : {};
  $("#notice").textContent = regenerate ? "正在按补充信息重新生成…" : "正在保存校正并学习你的偏好…";
  const draft = await json(`/api/draft/${encodeURIComponent(currentDraft.date)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editedReport: $("#draftEditor").value, answers: collectGapAnswers(), aliases, regenerate }) });
  renderDraft(draft); $("#notice").textContent = regenerate ? "已重新生成预览；证据映射也已更新。" : "校正已保存，项目归类和写作偏好会在以后自动沿用。";
}

function renderMorning(brief) {
  $("#morning").innerHTML = `<pre>${escapeHtml(brief.content)}</pre>`;
  markPopulated("#morning", true);
}

async function loadMorning() {
  try { renderMorning(await json(`/api/morning?date=${encodeURIComponent(today())}`)); }
  catch (error) { if (!String(error.message).includes("尚未生成晨间续接")) throw error; }
}

function renderSearchResults(results) {
  $("#archiveResults").innerHTML = results.length ? results.map((result, index) => `<article class="search-result"><span>${index + 1}</span><div><b>${escapeHtml(result.title)}</b><small>${escapeHtml(result.date)} · ${result.source === "project" ? "项目档案" : "工作报告"} · 相关度 ${Math.round(result.score * 100)}%</small><p>${escapeHtml(result.snippet)}</p>${result.evidenceIds.length ? `<em>${result.evidenceIds.length} 条原始证据可追溯</em>` : ""}</div></article>`).join("") : '<p class="hint">没有找到相关档案。</p>';
  markPopulated("#archiveResults", results.length > 0);
}

async function loadRuns() {
  const runs = await json("/api/runs");
  $("#runs").innerHTML = runs.length ? runs.map(run => {
    const label = run.kind === "meeting" ? run.title || "Teams 会议内容" : run.kind === "weekly" ? `周报 ${run.start} 至 ${run.end}` : run.kind === "monthly" ? `月报 ${run.start?.slice(0, 7) || ""}` : run.date || "—";
    const url = run.url || run.document?.url;
    const result = run.status === "meeting_included" ? "已纳入日报素材" : run.status === "meeting_ignored" ? "无有效内容，已忽略" : run.status === "success" ? (run.sourceDays ? `汇总 ${run.sourceDays} 个工作日` : "已生成") : "生成失败";
    return `<article class="run ${escapeHtml(run.status)}"><div><b>${escapeHtml(label)}</b><small>${new Date(run.at).toLocaleString("zh-CN")}</small></div><span>${result}</span>${url ? `<a target="_blank" href="${escapeHtml(url)}">打开文档 ↗</a>` : run.error ? `<em>${escapeHtml(run.error)}</em>` : ""}</article>`;
  }).join("") : '<p class="hint">还没有生成记录。</p>';
  markPopulated("#runs", runs.length > 0);
}

const meetingStatusText = value => ({ recording: "正在记录", transcribing: "正在本地转写", summarizing: "正在整理工作内容", included: "已纳入日报素材", ignored: "无有效内容，已忽略", published: "旧版独立纪要", failed: "处理失败" })[value] || value;

async function loadMeetings() {
  const meetings = await json("/api/meetings");
  $("#meetings").innerHTML = meetings.length ? meetings.map(meeting => `<article class="run ${escapeHtml(meeting.status)}"><div><b>${escapeHtml(meeting.title)}</b><small>${new Date(meeting.startedAt).toLocaleString("zh-CN")} · ${meeting.durationSeconds ? `${Math.max(1, Math.round(meeting.durationSeconds / 60))} 分钟` : meeting.origin === "automatic" ? "自动识别" : "手动记录"}</small></div><span>${escapeHtml(meetingStatusText(meeting.status))}</span>${meeting.error ? `<em title="${escapeHtml(meeting.error)}">${escapeHtml(meeting.error)}</em>` : ""}</article>`).join("") : '<p class="hint">还没有会议记录。</p>';
  markPopulated("#meetings", meetings.length > 0);
}

async function loadMeetingStatus() {
  const status = await json("/api/meeting/status");
  $("#teamsStatus").classList.remove("loading-state");
  if (status.supported === false) {
    $("#meetingStart").disabled = true;
    $("#meetingStop").disabled = true;
    $("#teamsStatus").innerHTML = `<b>当前平台暂不支持 Teams 系统音频</b><small>Agent 日志、终端、前台应用和自动报告不受影响</small>`;
    $("#teamsHelp").textContent = "Windows/Linux 预览版暂不采集会议音频；该能力不会生成空会议或影响其他工作记录。";
    $("#teamsSection").querySelectorAll("input, details").forEach(element => element.disabled = true);
    return status;
  }
  const recording = status.current?.status === "recording";
  $("#meetingStart").disabled = recording;
  $("#meetingStop").disabled = !recording;
  $("#teamsStatus").innerHTML = recording
    ? `<b>正在记录：${escapeHtml(status.current.title)}</b><small>开始于 ${new Date(status.current.startedAt).toLocaleTimeString("zh-CN")}</small>`
    : status.teamsInstalled && status.systemAudioCaptureAvailable
      ? `<b>Teams 已就绪</b><small>${status.callActivityDetected ? "检测到 Teams 通话音频" : status.meetingWindowDetected ? "检测到入会窗口" : "正在等待 Teams 通话"}</small>`
      : `<b>Teams 采集尚未就绪</b><small>${escapeHtml(status.lastError || (!status.teamsInstalled ? "Microsoft Teams 当前未运行" : "系统音频采集器尚未安装"))}</small>`;
  return status;
}

async function load() {
  const [settings, status, setup] = await Promise.all([json("/api/settings"), json("/api/status"), json("/api/setup/status")]);
  for (const [key, value] of Object.entries(settings)) {
    const element = form.elements[key];
    if (element?.type === "checkbox") element.checked = value === true;
    else if (element) element.value = ["ignoredProcesses", "redactionTerms"].includes(key) && Array.isArray(value) ? value.join("\n") : value || "";
  }
  $("#state").textContent = setup.ready ? "配置完整，后台正在运行" : "后台运行中，初始化尚未完成";
  $("#meta").textContent = `晨间 ${scheduleClock(status.morningSchedule)} · 日报 ${scheduleClock(status.schedule)}\n周一 ${scheduleClock(status.weeklySchedule)} · 每月 1 日 ${scheduleClock(status.monthlySchedule)}`;
  const lark = setup.lark;
  $("#larkStatus").innerHTML = lark.installed
    ? `<b>已连接：${escapeHtml(lark.user?.userName || lark.identity || "飞书用户")}</b><small>CLI ${lark.verified ? "认证有效" : "需要重新授权"} · ${escapeHtml(lark.binary)}</small>`
    : `<b>尚未连接飞书 CLI</b><small>${escapeHtml(lark.error || "请按安装指南完成配置与登录")}</small>`;
  $("#larkStatus").classList.remove("loading-state");
  document.body.dataset.capture = settings.capturePaused ? "paused" : "active";
  $("#dot").style.background = settings.capturePaused ? "#c64f37" : "";
  if (settings.capturePaused) {
    $("#state").textContent = "工作采集已暂停";
    $("#dot").style.background = "#c64f37";
  }
  await Promise.all([loadRuns(), loadMeetings(), loadMeetingStatus(), loadGraph(), loadDraft(), loadMorning()]);
}

form.addEventListener("submit", async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(form));
  data.ignoredProcesses = data.ignoredProcesses.split("\n").map(value => value.trim()).filter(Boolean);
  data.redactionTerms = data.redactionTerms.split("\n").map(value => value.trim()).filter(Boolean);
  data.teamsMeetingEnabled = form.elements.teamsMeetingEnabled.checked;
  data.teamsAutoRecord = form.elements.teamsAutoRecord.checked;
  data.capturePaused = form.elements.capturePaused.checked;
  data.redactionEnabled = form.elements.redactionEnabled.checked;
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

$("#meetingStart").addEventListener("click", async () => {
  $("#notice").textContent = "正在启动 Teams 会议记录…";
  try { const meeting = await json("/api/meeting/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); $("#notice").textContent = `已开始记录：${meeting.title}`; await Promise.all([loadMeetingStatus(), loadMeetings()]); }
  catch (error) { $("#notice").textContent = error.message; }
});

$("#meetingStop").addEventListener("click", async () => {
  $("#notice").textContent = "正在结束录音；本地转写和内容整理会在后台继续处理…";
  try { await json("/api/meeting/stop", { method: "POST" }); $("#notice").textContent = "录音已结束，正在本地转写；有效内容会自动纳入今天的日报素材。"; await Promise.all([loadMeetingStatus(), loadMeetings()]); }
  catch (error) { $("#notice").textContent = error.message; }
});

async function loadAudit() {
  const date = today();
  const audit = await json(`/api/audit?date=${encodeURIComponent(date)}`);
  auditEvidence = new Map((audit.activities || []).map(item => [item.evidenceId, item]));
  const sources = Object.entries(audit.byProcess || {}).map(([name, count]) => `${escapeHtml(name)} ${count}`).join(" · ");
  $("#auditSummary").innerHTML = `<b>${audit.eventCount} 条已过滤素材</b><small>${sources || "今天还没有工作素材"} · ${audit.redactionEnabled ? "敏感信息过滤已开启" : "敏感信息过滤已关闭"}</small>`;
  $("#audit").innerHTML = audit.activities?.length ? audit.activities.map(item => `<article class="audit-item"><time>${new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time><b>${escapeHtml(item.process)}</b><span>${escapeHtml(item.message)}</span></article>`).join("") : '<p class="hint">还没有可查看的采集内容。</p>';
  $("#metricEvidence").textContent = audit.eventCount || 0;
  markPopulated("#auditSummary", true);
  markPopulated("#audit", Boolean(audit.activities?.length));
  if (currentDraft) renderTrace(currentDraft);
}

$("#auditRefresh").addEventListener("click", () => loadAudit().catch(error => $("#notice").textContent = error.message));
$("#refresh").addEventListener("click", () => loadRuns().catch(error => $("#notice").textContent = error.message));
$("#meetingRefresh").addEventListener("click", () => Promise.all([loadMeetingStatus(), loadMeetings()]).catch(error => $("#notice").textContent = error.message));
$("#graphRefresh").addEventListener("click", () => loadGraph().catch(error => $("#notice").textContent = error.message));
$("#draftGenerate").addEventListener("click", () => generateDraft(true).catch(error => $("#notice").textContent = error.message));
$("#draftSave").addEventListener("click", () => saveDraft(false).catch(error => $("#notice").textContent = error.message));
$("#draftRegenerate").addEventListener("click", () => saveDraft(true).catch(error => $("#notice").textContent = error.message));
$("#draftEditor").addEventListener("input", () => $("#draftCurrent").textContent = $("#draftEditor").value);
$("#draftPublish").addEventListener("click", async () => {
  if (!currentDraft) return;
  $("#notice").textContent = "正在把当前版本写入飞书…";
  try {
    await saveDraft(false);
    const output = await json(`/api/draft/${encodeURIComponent(currentDraft.date)}/publish`, { method: "POST" });
    renderDraft(output.draft); $("#notice").innerHTML = `已发布当前版本：<a href="${escapeHtml(output.url)}" target="_blank">${escapeHtml(output.title)}</a>`; await loadRuns();
  } catch (error) { $("#notice").textContent = error.message; }
});
$("#morningGenerate").addEventListener("click", async () => {
  $("#notice").textContent = "正在从最近工作档案恢复上下文…";
  try { const brief = await json("/api/morning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: today(), force: true }) }); renderMorning(brief); $("#notice").textContent = "晨间续接已生成。"; }
  catch (error) { $("#notice").textContent = error.message; }
});
$("#archiveSearch").addEventListener("click", async () => {
  const query = $("#archiveQuery").value.trim(); if (!query) return;
  $("#archiveAnswer").innerHTML = "";
  try { const output = await json(`/api/search?q=${encodeURIComponent(query)}`); renderSearchResults(output.results); }
  catch (error) { $("#notice").textContent = error.message; }
});
$("#archiveAsk").addEventListener("click", async () => {
  const question = $("#archiveQuery").value.trim(); if (!question) return;
  $("#archiveAnswer").innerHTML = '<p class="hint">正在检索本地档案并组织答案…</p>';
  try { const output = await json("/api/search/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }); $("#archiveAnswer").innerHTML = `<pre>${escapeHtml(output.answer)}</pre>`; renderSearchResults(output.results); }
  catch (error) { $("#archiveAnswer").innerHTML = ""; $("#notice").textContent = error.message; }
});
$("#archiveQuery").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); $("#archiveSearch").click(); } });
initializeFrame();
load().then(loadAudit).then(() => document.body.classList.add("is-ready")).catch(error => $("#notice").textContent = error.message);
setInterval(() => Promise.all([loadMeetingStatus(), loadMeetings()]).catch(() => {}), 5000);
