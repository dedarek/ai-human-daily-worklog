import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, appendFile, readdir, rename, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Secrets, Settings } from "./types.js";
import { defaultDataDir, worklogPlatform } from "./platform.js";
import { atomicWriteFile } from "./jsonStore.js";

const exec = promisify(execFile);
const legacyDataDir = join(process.cwd(), "data");
const platformDataDir = defaultDataDir();
export const dataDir = process.env.WORKLOG_DATA_DIR || platformDataDir;
const settingsFile = join(dataDir, "settings.json");
const keychainService = "MacWorklogFeishu";

async function secureExistingData(root: string) {
  const marker = join(root, ".permissions-v1");
  if (existsSync(marker)) return;
  async function walk(directory: string) {
    await chmod(directory, 0o700).catch(() => {});
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await chmod(path, 0o600).catch(() => {});
    }
  }
  await walk(root);
  await atomicWriteFile(marker, JSON.stringify({ securedAt: new Date().toISOString() }));
}

export const defaults: Settings = {
  schedule: "0 18 * * 1-5",
  weeklySchedule: "0 8 * * 1",
  monthlySchedule: "10 8 1 * *",
  morningSchedule: "30 8 * * 1-5",
  timezone: "Asia/Shanghai",
  ignoredProcesses: ["Finder", "Control Center", "Notification Center", "Dock", "loginwindow", "WindowServer", "explorer", "SearchHost", "ShellExperienceHost", "gnome-shell", "plasmashell"],
  capturePaused: false,
  redactionEnabled: true,
  redactionTerms: [],
  markdownOutputEnabled: true,
  markdownOutputDir: join(dataDir, "exports"),
  llmBaseUrl: "https://api.openai.com/v1",
  llmProtocol: "openai",
  llmModel: "gpt-4.1-mini",
  larkCliPath: "",
  feishuBaseUrl: "https://feishu.cn",
  feishuWikiNodeToken: "",
  teamsMeetingEnabled: worklogPlatform() === "macos",
  teamsAutoRecord: worklogPlatform() === "macos",
  whisperCliPath: process.env.WORKLOG_BUNDLED_WHISPER_CLI || (worklogPlatform() === "windows" ? join(dataDir, "bin", "whisper-cli.exe") : worklogPlatform() === "linux" ? "/usr/local/bin/whisper-cli" : "/opt/homebrew/bin/whisper-cli"),
  whisperModelPath: join(dataDir, "models", "ggml-small.bin"),
  retentionEnabled: false,
  evidenceRetentionDays: 30,
  meetingAudioRetentionDays: 7,
};

export async function setupStore() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
  const migrate = worklogPlatform() === "macos" && dataDir === platformDataDir && dataDir !== legacyDataDir
    && !existsSync(join(dataDir, ".migration-complete")) && !existsSync(join(dataDir, "settings.json")) && existsSync(legacyDataDir);
  if (migrate) {
    for (const entry of await readdir(legacyDataDir)) await cp(join(legacyDataDir, entry), join(dataDir, entry), { recursive: true, force: false, errorOnExist: false });
    await atomicWriteFile(join(dataDir, ".migration-complete"), JSON.stringify({ from: legacyDataDir, migratedAt: new Date().toISOString() }));
  }
  await secureExistingData(dataDir);
}
export async function getSettings(): Promise<Settings> {
  let raw: string;
  try { raw = await readFile(settingsFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  try { return { ...defaults, ...JSON.parse(raw) }; }
  catch (error) { throw new Error(`配置文件已损坏，已停止使用默认值覆盖：${settingsFile}`, { cause: error }); }
}
export async function saveSettings(settings: Settings) {
  await setupStore();
  await atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2));
}
async function keychain(command: "add-generic-password" | "find-generic-password", account: string, value?: string) {
  const args = command === "add-generic-password"
    ? [command, "-U", "-s", keychainService, "-a", account, "-w", value!]
    : [command, "-s", keychainService, "-a", account, "-w"];
  const { stdout } = await exec("security", args);
  return stdout.trim();
}
function runWithInput(command: string, args: string[], input: string, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `凭据存储退出码 ${code}`)));
    child.stdin.end(input);
  });
}

const powershell = () => process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
const windowsPowerShellEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));

export async function saveSecrets(secrets: Partial<Secrets>) {
  if (!secrets.llmApiKey) return;
  if (worklogPlatform() === "macos") {
    await keychain("add-generic-password", "llm-api-key", secrets.llmApiKey);
    return;
  }
  await mkdir(dataDir, { recursive: true });
  if (worklogPlatform() === "windows") {
    const script = "$plain=[Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $plain -AsPlainText -Force)";
    const encrypted = await runWithInput(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], secrets.llmApiKey, windowsPowerShellEnv());
    await atomicWriteFile(join(dataDir, "secrets.dpapi"), encrypted);
    return;
  }
  try {
    await runWithInput("secret-tool", ["store", "--label=Worklog", "service", "Worklog", "account", "llm-api-key"], secrets.llmApiKey);
    return;
  } catch { /* headless Linux may not provide Secret Service */ }
  // Linux fallback for environments without Secret Service. Directory and file are owner-only.
  await atomicWriteFile(join(dataDir, "secrets.json"), JSON.stringify({ llmApiKey: secrets.llmApiKey }));
}
export async function getSecrets(): Promise<Secrets> {
  if (worklogPlatform() === "macos") {
    const fetch = async (name: string) => { try { return await keychain("find-generic-password", name); } catch { return ""; } };
    return { llmApiKey: await fetch("llm-api-key") };
  }
  if (worklogPlatform() === "windows") {
    try {
      const encrypted = await readFile(join(dataDir, "secrets.dpapi"), "utf8");
      const script = "$cipher=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString $cipher; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}";
      return { llmApiKey: await runWithInput(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], encrypted, windowsPowerShellEnv()) };
    } catch { return { llmApiKey: process.env.WORKLOG_LLM_API_KEY || "" }; }
  }
  try {
    const value = (await exec("secret-tool", ["lookup", "service", "Worklog", "account", "llm-api-key"])).stdout.trim();
    if (value) return { llmApiKey: value };
  }
  catch { /* use owner-only fallback below */ }
  try { return { llmApiKey: JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8")).llmApiKey || "" }; }
  catch { return { llmApiKey: process.env.WORKLOG_LLM_API_KEY || "" }; }
}
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export async function logRun(entry: object) {
  await setupStore();
  const path = join(dataDir, "runs.jsonl");
  const size = await stat(path).then(value => value.size).catch(() => 0);
  if (size > 5 * 1024 * 1024) await rename(path, `${path}.1`).catch(() => {});
  await appendFile(path, JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}
