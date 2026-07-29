import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Settings } from "./types.js";

type RunOptions = { input?: string; allowNonEnvelope?: boolean; timeoutMs?: number };

async function nvmCandidates() {
  const root = join(process.env.HOME ?? "", ".nvm", "versions", "node");
  try {
    const versions = await readdir(root);
    return versions.sort().reverse().map(version => join(root, version, "bin", "lark-cli"));
  } catch { return []; }
}

export async function findLarkCli(configured?: string) {
  const candidates = [configured, process.env.LARK_CLI_PATH, process.env.WORKLOG_BUNDLED_LARK_CLI, "/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli", ...(await nvmCandidates())].filter(Boolean) as string[];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error("未找到飞书 CLI。请先运行：npm install -g @larksuite/cli");
  return found;
}

export async function runLarkCli(settings: Pick<Settings, "larkCliPath">, args: string[], options: RunOptions = {}) {
  const binary = await findLarkCli(settings.larkCliPath);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
      detached: true,
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
