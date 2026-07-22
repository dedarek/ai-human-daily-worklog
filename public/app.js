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
    const label = run.kind === "meeting" ? run.title || "Teams 会议内容" : run.kind === "weekly" ? `周报 ${run.start} 至 ${run.end}` : run.kind === "monthly" ? `月报 ${run.start?.slice(0, 7) || ""}` : run.date || "—";
    const url = run.url || run.document?.url;
    const result = run.status === "meeting_included" ? "已纳入日报素材" : run.status === "meeting_ignored" ? "无有效内容，已忽略" : run.status === "success" ? (run.sourceDays ? `汇总 ${run.sourceDays} 个工作日` : "已生成") : "生成失败";
    return `<article class="run ${escapeHtml(run.status)}"><div><b>${escapeHtml(label)}</b><small>${new Date(run.at).toLocaleString("zh-CN")}</small></div><span>${result}</span>${url ? `<a target="_blank" href="${escapeHtml(url)}">打开文档 ↗</a>` : run.error ? `<em>${escapeHtml(run.error)}</em>` : ""}</article>`;
  }).join("") : '<p class="hint">还没有生成记录。</p>';
}

const meetingStatusText = value => ({ recording: "正在记录", transcribing: "正在本地转写", summarizing: "正在整理工作内容", included: "已纳入日报素材", ignored: "无有效内容，已忽略", published: "旧版独立纪要", failed: "处理失败" })[value] || value;

async function loadMeetings() {
  const meetings = await json("/api/meetings");
  $("#meetings").innerHTML = meetings.length ? meetings.map(meeting => `<article class="run ${escapeHtml(meeting.status)}"><div><b>${escapeHtml(meeting.title)}</b><small>${new Date(meeting.startedAt).toLocaleString("zh-CN")} · ${meeting.durationSeconds ? `${Math.max(1, Math.round(meeting.durationSeconds / 60))} 分钟` : meeting.origin === "automatic" ? "自动识别" : "手动记录"}</small></div><span>${escapeHtml(meetingStatusText(meeting.status))}</span>${meeting.error ? `<em title="${escapeHtml(meeting.error)}">${escapeHtml(meeting.error)}</em>` : ""}</article>`).join("") : '<p class="hint">还没有会议记录。</p>';
}

async function loadMeetingStatus() {
  const status = await json("/api/meeting/status");
  const recording = status.current?.status === "recording";
  $("#meetingStart").disabled = recording;
  $("#meetingStop").disabled = !recording;
  $("#teamsStatus").innerHTML = recording
    ? `<b>正在记录：${escapeHtml(status.current.title)}</b><small>开始于 ${new Date(status.current.startedAt).toLocaleTimeString("zh-CN")}</small>`
    : status.teamsInstalled && status.teamsAudioInstalled
      ? `<b>Teams 已就绪</b><small>${status.meetingWindowDetected || status.teamsAudioRunning ? "检测到会议活动" : "正在等待 Teams 会议"}</small>`
      : `<b>Teams 采集尚未就绪</b><small>${escapeHtml(status.lastError || (!status.teamsInstalled ? "Microsoft Teams 当前未运行" : "未找到 Microsoft Teams Audio 设备"))}</small>`;
  return status;
}

async function load() {
  const [settings, status, setup] = await Promise.all([json("/api/settings"), json("/api/status"), json("/api/setup/status")]);
  for (const [key, value] of Object.entries(settings)) {
    const element = form.elements[key];
    if (element?.type === "checkbox") element.checked = value === true;
    else if (element) element.value = key === "ignoredProcesses" ? value.join("\n") : value || "";
  }
  $("#state").textContent = setup.ready ? "配置完整，后台正在运行" : "后台运行中，初始化尚未完成";
  $("#meta").textContent = `日报 ${status.schedule} · 周报 ${status.weeklySchedule} · 月报 ${status.monthlySchedule}（${status.timezone}）`;
  const lark = setup.lark;
  $("#larkStatus").innerHTML = lark.installed
    ? `<b>已连接：${escapeHtml(lark.user?.userName || lark.identity || "飞书用户")}</b><small>CLI ${lark.verified ? "认证有效" : "需要重新授权"} · ${escapeHtml(lark.binary)}</small>`
    : `<b>尚未连接飞书 CLI</b><small>${escapeHtml(lark.error || "请按安装指南完成配置与登录")}</small>`;
  await Promise.all([loadRuns(), loadMeetings(), loadMeetingStatus()]);
}

form.addEventListener("submit", async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(form));
  data.ignoredProcesses = data.ignoredProcesses.split("\n").map(value => value.trim()).filter(Boolean);
  data.teamsMeetingEnabled = form.elements.teamsMeetingEnabled.checked;
  data.teamsAutoRecord = form.elements.teamsAutoRecord.checked;
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

$("#refresh").addEventListener("click", () => loadRuns().catch(error => $("#notice").textContent = error.message));
$("#meetingRefresh").addEventListener("click", () => Promise.all([loadMeetingStatus(), loadMeetings()]).catch(error => $("#notice").textContent = error.message));
load().catch(error => $("#notice").textContent = error.message);
setInterval(() => Promise.all([loadMeetingStatus(), loadMeetings()]).catch(() => {}), 5000);
