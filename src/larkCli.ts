import { access, copyFile, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Settings } from "./types.js";
import { dataDir } from "./store.js";
import { createMutex } from "./jsonStore.js";

type RunOptions = { input?: string; allowNonEnvelope?: boolean; timeoutMs?: number };
const materializeBundledCli = createMutex();

async function bundledCli(binary: string) {
  if (binary !== process.env.WORKLOG_BUNDLED_LARK_CLI) return binary;
  const packageRoot = dirname(dirname(binary));
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(metadata.version ?? "")) throw new Error("安装包内的飞书 CLI 元数据无效。");
  const runtimeRoot = join(dataDir, "runtime", "lark-cli", metadata.version!);
  const executable = join(runtimeRoot, "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  try { await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK); return executable; }
  catch { /* install below */ }

  return materializeBundledCli(async () => {
    try { await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK); return executable; }
    catch { /* another request has not completed installation */ }
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await cp(join(packageRoot, "scripts"), join(runtimeRoot, "scripts"), { recursive: true, force: true });
    await copyFile(join(packageRoot, "checksums.txt"), join(runtimeRoot, "checksums.txt"));
    await copyFile(join(packageRoot, "package.json"), join(runtimeRoot, "package.json"));
    const result = await runLarkProcess(join(runtimeRoot, "scripts", "install.js"), [], { timeoutMs: 180_000 });
    if (result.code !== 0) throw new Error(`飞书 CLI 安装失败：${result.stderr || result.stdout || `退出码 ${result.code}`}`);
    await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return executable;
  });
}

async function nvmCandidates() {
  const root = join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = await readdir(root);
    return versions.sort((a, b) => {
      const parts = (value: string) => value.replace(/^v/, "").split(".").map(Number);
      const left = parts(a), right = parts(b);
      return (right[0] - left[0]) || (right[1] - left[1]) || (right[2] - left[2]);
    }).map(version => join(root, version, "bin", "lark-cli"));
  } catch { return []; }
}

export async function findLarkCli(configured?: string) {
  const executable = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
  const appDataCli = process.platform === "win32" && process.env.APPDATA ? join(process.env.APPDATA, "npm", executable) : "";
  const candidates = [configured, process.env.LARK_CLI_PATH, process.env.WORKLOG_BUNDLED_LARK_CLI, appDataCli, "/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli", ...(await nvmCandidates())].filter(Boolean) as string[];
  let found: string | undefined;
  for (const candidate of candidates) {
    try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); found = await bundledCli(candidate); break; }
    catch { /* try next candidate */ }
  }
  if (!found) throw new Error("未找到飞书 CLI。请先运行：npm install -g @larksuite/cli");
  return found;
}

export async function runLarkProcess(binary: string, args: string[], options: RunOptions = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const javaScript = /\.(?:c|m)?js$/i.test(binary);
    const useShell = process.platform === "win32" && binary.toLowerCase().endsWith(".cmd");
    const child = spawn(javaScript ? process.execPath : binary, javaScript ? [binary, ...args] : args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      detached: true,
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); }
      catch { child.kill("SIGTERM"); }
    }, options.timeoutMs) : null;
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", error => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout: stdout.trim(), stderr: timedOut ? "飞书 CLI 状态检查超时" : stderr.trim() });
    });
    child.stdin.end(options.input ?? "");
  });
}

export async function runLarkCli(settings: Pick<Settings, "larkCliPath">, args: string[], options: RunOptions = {}) {
  const binary = await findLarkCli(settings.larkCliPath);
  const result = await runLarkProcess(binary, args, options);
  const parse = (value: string) => { try { return JSON.parse(value); } catch { return undefined; } };
  const body = parse(result.stdout) ?? parse(result.stderr);
  if (result.code !== 0 || (!options.allowNonEnvelope && body?.ok !== true)) {
    const error = body?.error;
    const details = [error?.message, error?.hint, error?.missing_scopes?.length ? `缺少权限：${error.missing_scopes.join(", ")}` : ""].filter(Boolean).join("；");
    throw new Error(`飞书 CLI 执行失败：${details || result.stderr || result.stdout || `退出码 ${result.code}`}`);
  }
  if (!body) throw new Error(`飞书 CLI 返回了无法解析的结果：${result.stdout || result.stderr || "空响应"}`);
  return { body, binary };
}

export async function getLarkStatus(settings: Pick<Settings, "larkCliPath">) {
  const { body, binary } = await runLarkCli(settings, ["auth", "status", "--json", "--verify"], { allowNonEnvelope: true, timeoutMs: 12_000 });
  return {
    installed: true,
    binary,
    verified: body.verified === true,
    identity: body.identity,
    user: body.identities?.user ? {
      status: body.identities.user.status,
      verified: body.identities.user.verified,
      userName: body.identities.user.userName,
      openId: body.identities.user.openId,
      tokenStatus: body.identities.user.tokenStatus,
      expiresAt: body.identities.user.expiresAt,
    } : null,
  };
}
