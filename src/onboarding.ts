import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { getNativeState, queueNativePermission } from "./nativeBridge.js";
import { dataDir, getSecrets, getSettings, saveSettings } from "./store.js";
import { findLarkCli, getLarkStatus, runLarkProcess } from "./larkCli.js";
import { platformCapabilities, worklogPlatform } from "./platform.js";
import { atomicWriteFile } from "./jsonStore.js";

const exec = promisify(execFile);
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const modelSha256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const modelPath = join(dataDir, "models", "ggml-small.bin");
const modelVerificationPath = `${modelPath}.verified.json`;
const permissionTool = join(dataDir, "bin", "permission-status");
const audioTool = join(dataDir, "bin", "system-audio-capture");

type DownloadState = { status: "idle" | "downloading" | "ready" | "failed"; received: number; total: number; error?: string };
let downloadState: DownloadState = { status: existsSync(modelPath) ? "ready" : "idle", received: 0, total: 0 };
let larkLogin: { status: "idle" | "waiting" | "complete" | "failed"; verificationUrl?: string; error?: string } = { status: "idle" };
let modelVerification: { mtimeMs: number; verified: boolean; verifying?: boolean } | null = null;
let modelVerificationTask: Promise<void> | null = null;
let larkStatusCache: { at: number; value: Record<string, unknown> } | null = null;
let larkStatusTask: Promise<Record<string, unknown>> | null = null;

async function jsonTool(path: string, args: string[]) {
  if (!existsSync(path)) return { error: `缺少本地辅助程序：${path}` };
  try { return JSON.parse((await exec(path, args, { timeout: 30_000 })).stdout); }
  catch (error) { return { error: String(error instanceof Error ? error.message : error).slice(0, 300) }; }
}

async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function modelInfo() {
  if (!existsSync(modelPath)) return { installed: false, path: modelPath, bytes: 0, verified: false };
  const info = await stat(modelPath);
  if (!modelVerification && !modelVerificationTask) {
    const cached = await readFile(modelVerificationPath, "utf8").then(raw => JSON.parse(raw) as { size?: number; mtimeMs?: number; sha256?: string }).catch(() => null);
    if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs && cached.sha256 === modelSha256) {
      modelVerification = { mtimeMs: info.mtimeMs, verified: true };
    }
  }
  if (modelVerification?.mtimeMs !== info.mtimeMs && !modelVerificationTask) {
    modelVerification = { mtimeMs: info.mtimeMs, verified: false, verifying: true };
    modelVerificationTask = (async () => {
      const verified = info.size === 487_601_967 && await fileSha256(modelPath) === modelSha256;
      modelVerification = { mtimeMs: info.mtimeMs, verified };
      if (verified) await atomicWriteFile(modelVerificationPath, JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs, sha256: modelSha256 }));
      if (verified && downloadState.status !== "downloading") downloadState = { status: "ready", received: info.size, total: info.size };
    })().finally(() => { modelVerificationTask = null; });
  }
  const verification = modelVerification?.mtimeMs === info.mtimeMs ? modelVerification : { verified: false, verifying: true };
  return { installed: true, path: modelPath, bytes: info.size, verified: verification.verified, verifying: verification.verifying === true };
}

async function larkInfo(settings: Awaited<ReturnType<typeof getSettings>>) {
  if (larkStatusCache && Date.now() - larkStatusCache.at < 10_000) return larkStatusCache.value;
  if (!larkStatusTask) {
    larkStatusTask = getLarkStatus(settings)
      .then(value => value as Record<string, unknown>)
      .catch(error => ({ installed: false, error: String(error) }))
      .then(value => { larkStatusCache = { at: Date.now(), value }; return value; })
      .finally(() => { larkStatusTask = null; });
  }
  return larkStatusTask;
}

export async function onboardingStatus() {
  const settings = await getSettings(); const secrets = await getSecrets();
  const capabilities = platformCapabilities();
  const native = getNativeState();
  const helperScreen = capabilities.nativePermissions ? await jsonTool(audioTool, ["--permission-status"]) : { screenCapture: true };
  const helperAccessibility = capabilities.nativePermissions ? await jsonTool(permissionTool, []) : { accessibility: true };
  const screen = { screenCapture: native?.screenCapture === true || helperScreen.screenCapture === true };
  const accessibility = { accessibility: native?.accessibility === true || helperAccessibility.accessibility === true };
  const lark = await larkInfo(settings);
  const bundledWhisper = process.env.WORKLOG_BUNDLED_WHISPER_CLI;
  const whisperCli = [settings.whisperCliPath, bundledWhisper, "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", join(dataDir, "bin", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli")].find(value => value && existsSync(value));
  const model = await modelInfo();
  const meetingRequired = capabilities.teamsSystemAudio && settings.teamsMeetingEnabled;
  const meetingReady = !meetingRequired || Boolean(whisperCli && model.verified);
  const destinationReady = settings.markdownOutputEnabled || ((lark as any).verified === true && Boolean(settings.feishuWikiNodeToken));
  // 辅助功能只提升窗口标题质量，不应阻止核心采集；Teams 启用时系统音频权限才是必需项。
  const permissionsReady = !meetingRequired || screen.screenCapture === true;
  return {
    platform: worklogPlatform(),
    capabilities,
    permissions: { required: capabilities.nativePermissions, source: native ? "app+helper" : "helper", screenCapture: screen.screenCapture, accessibility: accessibility.accessibility },
    lark,
    larkLogin,
    llmConfigured: Boolean(secrets.llmApiKey && settings.llmBaseUrl && settings.llmModel),
    wikiConfigured: Boolean(settings.feishuWikiNodeToken),
    whisper: { required: meetingRequired, cliInstalled: Boolean(whisperCli), cliPath: whisperCli || "", model, download: downloadState },
    complete: permissionsReady && Boolean(secrets.llmApiKey && meetingReady && destinationReady),
  };
}

export async function requestPermission(kind: "screen" | "accessibility") {
  if (worklogPlatform() !== "macos") return { granted: true, notRequired: true };
  const native = getNativeState();
  if (native) {
    if (kind === "screen" && native.screenCapture) return { screenCapture: true };
    if (kind === "accessibility" && native.accessibility) return { accessibility: true };
    const helper = kind === "screen" ? await jsonTool(audioTool, ["--permission-status"]) : await jsonTool(permissionTool, []);
    if (kind === "screen" && helper.screenCapture === true) return { screenCapture: true };
    if (kind === "accessibility" && helper.accessibility === true) return { accessibility: true };
    queueNativePermission(kind);
    return kind === "screen" ? { screenCapture: native.screenCapture } : { accessibility: native.accessibility };
  }
  return kind === "screen"
    ? jsonTool(audioTool, ["--request-permission"])
    : jsonTool(permissionTool, ["--request-accessibility"]);
}

export async function configureLark(appId: string, appSecret: string) {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId) || !appSecret) throw new Error("请填写有效的飞书 App ID 和 App Secret。");
  const binary = await findLarkCli();
  const result = await runLarkProcess(binary, ["config", "init", "--app-id", appId, "--app-secret-stdin", "--brand", "feishu", "--lang", "zh_cn", "--force-init"], { input: `${appSecret}\n`, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "飞书 CLI 配置失败。");
  const settings = await getSettings(); await saveSettings({ ...settings, larkCliPath: binary });
  larkStatusCache = null;
  return { ok: true };
}

export async function beginLarkLogin() {
  const binary = await findLarkCli((await getSettings()).larkCliPath);
  const result = await runLarkProcess(binary, ["auth", "login", "--no-wait", "--json", "--recommend"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "无法开始飞书授权。");
  const body = JSON.parse(result.stdout);
  if (!body.device_code || !body.verification_url) throw new Error("飞书 CLI 没有返回授权链接。");
  larkLogin = { status: "waiting", verificationUrl: body.verification_url };
  void runLarkProcess(binary, ["auth", "login", "--device-code", body.device_code, "--json"], { timeoutMs: 10 * 60_000 }).then(done => {
    larkLogin = done.code === 0 ? { status: "complete" } : { status: "failed", error: done.stderr || done.stdout };
    larkStatusCache = null;
  }).catch(error => larkLogin = { status: "failed", error: String(error) });
  return { verificationUrl: body.verification_url };
}

export function startModelDownload() {
  if (downloadState.status === "downloading") return downloadState;
  downloadState = { status: "downloading", received: 0, total: 487_601_967 };
  void (async () => {
    const temporary = `${modelPath}.download`;
    try {
      await mkdir(join(dataDir, "models"), { recursive: true });
      const existing = await stat(temporary).then(info => info.size).catch(() => 0);
      const disk = await statfs(join(dataDir, "models"));
      const free = Number(disk.bavail) * Number(disk.bsize);
      const remaining = Math.max(0, 487_601_967 - existing);
      if (free < remaining + 100 * 1024 * 1024) throw new Error("磁盘空间不足，至少需要模型剩余大小再加 100 MB 临时空间。");
      downloadState.received = existing;
      const response = await fetch(modelUrl, { redirect: "follow", headers: existing ? { Range: `bytes=${existing}-` } : {}, signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`模型下载失败：HTTP ${response.status}`);
      const resumed = existing > 0 && response.status === 206;
      if (!resumed) downloadState.received = 0;
      downloadState.total = 487_601_967;
      const source = Readable.fromWeb(response.body as any);
      source.on("data", chunk => downloadState.received += chunk.length);
      await pipeline(source, createWriteStream(temporary, { mode: 0o600, flags: resumed ? "a" : "w" }));
      if (await fileSha256(temporary) !== modelSha256) { await rm(temporary, { force: true }); throw new Error("模型校验失败，下载文件不完整，已移除损坏文件。"); }
      await rename(temporary, modelPath);
      const info = await stat(modelPath);
      modelVerification = { mtimeMs: info.mtimeMs, verified: true };
      await atomicWriteFile(modelVerificationPath, JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs, sha256: modelSha256 }));
      const settings = await getSettings();
      const whisperCli = process.env.WORKLOG_BUNDLED_WHISPER_CLI || settings.whisperCliPath;
      await saveSettings({ ...settings, whisperCliPath: whisperCli, whisperModelPath: modelPath });
      downloadState = { status: "ready", received: 487_601_967, total: 487_601_967 };
    } catch (error) {
      downloadState = { ...downloadState, status: "failed", error: String(error) };
    }
  })();
  return downloadState;
}
