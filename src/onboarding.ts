import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { dataDir, getSecrets, getSettings, saveSettings } from "./store.js";
import { findLarkCli, getLarkStatus } from "./larkCli.js";
import { platformCapabilities, worklogPlatform } from "./platform.js";

const exec = promisify(execFile);
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
const modelSha256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const modelPath = join(dataDir, "models", "ggml-small.bin");
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
  if (!existsSync(path)) return {};
  try { return JSON.parse((await exec(path, args, { timeout: 30_000 })).stdout); }
  catch { return {}; }
}

function runLark(binary: string, args: string[], input = "", timeoutMs = 30_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const direct = process.platform === "win32" && /\.(?:cmd|exe)$/i.test(binary);
    const child = spawn(direct ? binary : process.execPath, direct ? args : [binary, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      detached: true,
      shell: direct && binary.toLowerCase().endsWith(".cmd"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); }
      catch { child.kill("SIGTERM"); }
    }, timeoutMs);
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout: stdout.trim(), stderr: timedOut ? "飞书 CLI 操作超时" : stderr.trim() });
    });
    child.stdin.end(input);
  });
}

async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function modelInfo() {
  if (!existsSync(modelPath)) return { installed: false, path: modelPath, bytes: 0, verified: false };
  const info = await stat(modelPath);
  if (modelVerification?.mtimeMs !== info.mtimeMs && !modelVerificationTask) {
    modelVerification = { mtimeMs: info.mtimeMs, verified: false, verifying: true };
    modelVerificationTask = (async () => {
      const verified = info.size === 487_601_967 && await fileSha256(modelPath) === modelSha256;
      modelVerification = { mtimeMs: info.mtimeMs, verified };
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
  const screen = capabilities.nativePermissions ? await jsonTool(audioTool, ["--permission-status"]) : { screenCapture: true };
  const accessibility = capabilities.nativePermissions ? await jsonTool(permissionTool, []) : { accessibility: true };
  const lark = await larkInfo(settings);
  const bundledWhisper = process.env.WORKLOG_BUNDLED_WHISPER_CLI;
  const whisperCli = [settings.whisperCliPath, bundledWhisper, "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", join(dataDir, "bin", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli")].find(value => value && existsSync(value));
  const model = await modelInfo();
  const meetingReady = !capabilities.teamsSystemAudio || Boolean(whisperCli && model.verified);
  return {
    platform: worklogPlatform(),
    capabilities,
    permissions: { required: capabilities.nativePermissions, screenCapture: screen.screenCapture === true, accessibility: accessibility.accessibility === true },
    lark,
    larkLogin,
    llmConfigured: Boolean(secrets.llmApiKey && settings.llmBaseUrl && settings.llmModel),
    wikiConfigured: Boolean(settings.feishuWikiNodeToken),
    whisper: { required: capabilities.teamsSystemAudio, cliInstalled: Boolean(whisperCli), cliPath: whisperCli || "", model, download: downloadState },
    complete: screen.screenCapture === true && accessibility.accessibility === true && (lark as any).verified === true && Boolean(secrets.llmApiKey && settings.feishuWikiNodeToken && meetingReady),
  };
}

export async function requestPermission(kind: "screen" | "accessibility") {
  if (worklogPlatform() !== "macos") return { granted: true, notRequired: true };
  return kind === "screen"
    ? jsonTool(audioTool, ["--request-permission"])
    : jsonTool(permissionTool, ["--request-accessibility"]);
}

export async function configureLark(appId: string, appSecret: string) {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId) || !appSecret) throw new Error("请填写有效的飞书 App ID 和 App Secret。");
  const binary = await findLarkCli();
  const result = await runLark(binary, ["config", "init", "--app-id", appId, "--app-secret-stdin", "--brand", "feishu", "--lang", "zh_cn", "--force-init"], `${appSecret}\n`);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "飞书 CLI 配置失败。");
  const settings = await getSettings(); await saveSettings({ ...settings, larkCliPath: binary });
  larkStatusCache = null;
  return { ok: true };
}

export async function beginLarkLogin() {
  const binary = await findLarkCli((await getSettings()).larkCliPath);
  const result = await runLark(binary, ["auth", "login", "--no-wait", "--json", "--recommend"]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "无法开始飞书授权。");
  const body = JSON.parse(result.stdout);
  if (!body.device_code || !body.verification_url) throw new Error("飞书 CLI 没有返回授权链接。");
  larkLogin = { status: "waiting", verificationUrl: body.verification_url };
  void runLark(binary, ["auth", "login", "--device-code", body.device_code, "--json"], "", 10 * 60_000).then(done => {
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
      await rm(temporary, { force: true });
      const response = await fetch(modelUrl, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`模型下载失败：HTTP ${response.status}`);
      downloadState.total = Number(response.headers.get("content-length")) || 487_601_967;
      const source = Readable.fromWeb(response.body as any);
      source.on("data", chunk => downloadState.received += chunk.length);
      await pipeline(source, createWriteStream(temporary, { mode: 0o600 }));
      if (await fileSha256(temporary) !== modelSha256) throw new Error("模型校验失败，下载文件不完整。");
      await rename(temporary, modelPath);
      const info = await stat(modelPath);
      modelVerification = { mtimeMs: info.mtimeMs, verified: true };
      const settings = await getSettings();
      const whisperCli = process.env.WORKLOG_BUNDLED_WHISPER_CLI || settings.whisperCliPath;
      await saveSettings({ ...settings, whisperCliPath: whisperCli, whisperModelPath: modelPath });
      downloadState = { status: "ready", received: 487_601_967, total: 487_601_967 };
    } catch (error) {
      await rm(temporary, { force: true });
      downloadState = { ...downloadState, status: "failed", error: String(error) };
    }
  })();
  return downloadState;
}
