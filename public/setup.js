const $ = selector => document.querySelector(selector);
const notice = message => $("#notice").textContent = message || "";

async function json(url, options) {
  const mutating = options && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase());
  const request = options ? { ...options, ...(mutating && options.body === undefined ? { body: "{}" } : {}), headers: { ...(options.headers || {}), ...(mutating ? { "Content-Type": "application/json", "X-Worklog-Request": "1" } : {}) } } : options;
  const response = await fetch(url, request); const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`本地服务返回了无法解析的响应（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(body.error || "请求失败"); return body;
}

const post = (url, body = {}) => json(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const stateText = (element, ok, yes, no) => { element.textContent = ok ? yes : no; element.className = ok ? "ok" : "warn"; };

async function refresh() {
  const [status, settings] = await Promise.all([json("/api/onboarding/status"), json("/api/settings")]);
  const platformName = ({ macos: "macOS", windows: "Windows", linux: "Linux" })[status.platform] || status.platform;
  $("#platformIntro").textContent = `正在配置 ${platformName} 版本。所有采集记录只保存在这台电脑。`;
  $("#permissionHelp").textContent = status.permissions.required
    ? "系统音频用于 Teams 会议；辅助功能用于识别前台应用和会议窗口。Worklog 不读取麦克风、键盘或屏幕画面。"
    : "当前平台无需 macOS 辅助功能权限；Worklog 读取前台应用和窗口名称，但不读取键盘、剪贴板或页面正文。";
  stateText($("#screenState"), status.permissions.screenCapture, status.permissions.required ? "已允许" : "当前平台无需授权", "等待系统授权");
  stateText($("#accessibilityState"), status.permissions.accessibility, status.permissions.required ? "已允许" : "当前平台无需授权", "等待系统授权");
  document.querySelectorAll("[data-permission]").forEach(button => button.disabled = status.permissions[button.dataset.permission === "screen" ? "screenCapture" : "accessibility"]);
  document.querySelectorAll("[data-permission]").forEach(button => button.classList.toggle("hidden", !status.permissions.required));

  const larkVerified = status.lark?.verified === true && status.lark?.identity === "user";
  $("#larkReady").classList.toggle("hidden", !larkVerified);
  $("#larkReady").textContent = larkVerified ? `已连接飞书用户：${status.lark.user?.userName || "已授权用户"}` : "";
  $("#loginLark").disabled = status.lark?.installed !== true;
  if (status.larkLogin?.status === "waiting") notice("请在浏览器完成飞书授权，完成后此页面会自动更新。");
  if (status.larkLogin?.status === "failed") notice(status.larkLogin.error || "飞书授权失败。");

  $("#llmProtocol").value = settings.llmProtocol || "openai";
  if (!$("#llmBaseUrl").value) $("#llmBaseUrl").value = settings.llmBaseUrl || "";
  if (!$("#llmModel").value) $("#llmModel").value = settings.llmModel || "";

  const model = status.whisper.model; const download = status.whisper.download;
  $("#whisperCard").classList.toggle("hidden", !status.whisper.required);
  const percent = download.total ? Math.min(100, Math.round(download.received / download.total * 100)) : 0;
  $("#modelProgress").style.width = `${model.verified ? 100 : percent}%`;
  $("#downloadModel").disabled = model.verified || download.status === "downloading";
  $("#modelState").textContent = model.verified ? "已下载并通过完整性校验" : model.verifying ? "模型已存在，正在后台校验完整性…" : download.status === "downloading" ? `正在下载 ${percent}%` : download.status === "failed" ? download.error : status.whisper.cliInstalled ? "转写程序已就绪，模型尚未下载" : "模型尚未下载；转写程序将在安装包中提供";

  const checks = [
    [status.permissions.screenCapture && status.permissions.accessibility, "系统权限"],
    [larkVerified, "飞书用户授权"],
    [status.llmConfigured, "LLM 配置"],
    [status.wikiConfigured, "知识库位置"],
    [!status.whisper.required || (model.verified && status.whisper.cliInstalled), status.whisper.required ? "本地会议转写" : "跨平台核心采集"],
  ];
  $("#summary").innerHTML = checks.map(([ok, label]) => `<span class="${ok ? "ok" : "warn"}">${ok ? "✓" : "○"} ${label}</span>`).join("　");
  $("#finishSetup").disabled = !status.complete;
  const steps = [checks[0][0], larkVerified || settings.markdownOutputEnabled, status.llmConfigured && (status.wikiConfigured || settings.markdownOutputEnabled) && checks[4][0], status.complete];
  const active = steps.findIndex(done => !done);
  document.querySelectorAll("#progress span").forEach((item, index) => item.className = steps[index] ? "done" : index === (active < 0 ? 3 : active) ? "active" : "");
  return status;
}

document.querySelectorAll("[data-permission]").forEach(button => button.addEventListener("click", async () => {
  try { notice("请在系统窗口中允许权限…"); await post(`/api/onboarding/permission/${button.dataset.permission}`); await refresh(); }
  catch (error) { notice(error.message); }
}));

$("#configureLark").addEventListener("click", async () => {
  try { notice("正在配置飞书 CLI…"); await post("/api/onboarding/lark-config", { appId: $("#larkAppId").value.trim(), appSecret: $("#larkAppSecret").value }); $("#larkAppSecret").value = ""; notice("飞书应用凭据已保存，请继续授权用户身份。"); await refresh(); }
  catch (error) { notice(error.message); }
});

$("#loginLark").addEventListener("click", async () => {
  try { notice("正在创建飞书授权链接…"); const result = await post("/api/onboarding/lark-login"); window.open(result.verificationUrl, "_blank", "noopener"); notice("已打开飞书授权页面。完成授权后返回这里。"); }
  catch (error) { notice(error.message); }
});

$("#saveConfiguration").addEventListener("click", async () => {
  try {
    notice("正在保存模型配置并验证知识库…");
    const current = await json("/api/settings");
    await post("/api/settings", { ...current, llmProtocol: $("#llmProtocol").value, llmBaseUrl: $("#llmBaseUrl").value.trim(), llmModel: $("#llmModel").value.trim(), llmApiKey: $("#llmApiKey").value });
    $("#llmApiKey").value = "";
    await post("/api/wiki-target", { url: $("#wikiUrl").value.trim() });
    notice("模型与飞书知识库配置完成。"); await refresh();
  } catch (error) { notice(error.message); }
});

$("#downloadModel").addEventListener("click", async () => { try { await post("/api/onboarding/model"); notice("模型开始在后台下载，可以继续配置其他步骤。"); await refresh(); } catch (error) { notice(error.message); } });
$("#refresh").addEventListener("click", () => refresh().catch(error => notice(error.message)));
$("#finishSetup").addEventListener("click", () => location.href = "/");

refresh().catch(error => notice(error.message));
setInterval(() => { if (document.visibilityState === "visible") refresh().catch(() => {}); }, 2500);
