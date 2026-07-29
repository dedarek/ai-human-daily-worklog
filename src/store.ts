import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Secrets, Settings } from "./types.js";
import { defaultDataDir, worklogPlatform } from "./platform.js";

const exec = promisify(execFile);
const legacyDataDir = join(process.cwd(), "data");
const platformDataDir = defaultDataDir();
export const dataDir = process.env.WORKLOG_DATA_DIR || platformDataDir;
const settingsFile = join(dataDir, "settings.json");
const keychainService = "MacWorklogFeishu";

export const defaults: Settings = {
  schedule: "0 18 * * 1-5",
  weeklySchedule: "0 8 * * 1",
  monthlySchedule: "10 8 1 * *",
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
};

export async function setupStore() {
  await mkdir(dataDir, { recursive: true });
  if (worklogPlatform() !== "macos" || dataDir !== platformDataDir || dataDir === legacyDataDir || existsSync(join(dataDir, ".migration-complete")) || existsSync(join(dataDir, "settings.json"))) return;
  if (!existsSync(legacyDataDir)) return;
  for (const entry of await readdir(legacyDataDir)) await cp(join(legacyDataDir, entry), join(dataDir, entry), { recursive: true, force: false, errorOnExist: false });
  await writeFile(join(dataDir, ".migration-complete"), JSON.stringify({ from: legacyDataDir, migratedAt: new Date().toISOString() }), { mode: 0o600 });
}
export async function getSettings(): Promise<Settings> {
  try { return { ...defaults, ...JSON.parse(await readFile(settingsFile, "utf8")) }; }
  catch { return defaults; }
}
export async function saveSettings(settings: Settings) {
  await setupStore();
  await writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
async function keychain(command: "add-generic-password" | "find-generic-password", account: string, value?: string) {
  const args = command === "add-generic-password"
    ? [command, "-U", "-s", keychainService, "-a", account, "-w", value!]
    : [command, "-s", keychainService, "-a", account, "-w"];
  const { stdout } = await exec("security", args);
  return stdout.trim();
}
function runWithInput(command: string, args: string[], input: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `凭据存储退出码 ${code}`)));
    child.stdin.end(input);
  });
}

const powershell = () => process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";

export async function saveSecrets(secrets: Partial<Secrets>) {
  if (!secrets.llmApiKey) return;
  if (worklogPlatform() === "macos") {
    await keychain("add-generic-password", "llm-api-key", secrets.llmApiKey);
    return;
  }
  await mkdir(dataDir, { recursive: true });
  if (worklogPlatform() === "windows") {
    const encrypted = await runWithInput(powershell(), ["-NoProfile", "-NonInteractive", "-Command", "$plain=[Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $plain -AsPlainText -Force)"], secrets.llmApiKey);
    await writeFile(join(dataDir, "secrets.dpapi"), encrypted, { mode: 0o600 });
    return;
  }
  try {
    await runWithInput("secret-tool", ["store", "--label=Worklog", "service", "Worklog", "account", "llm-api-key"], secrets.llmApiKey);
    return;
  } catch { /* headless Linux may not provide Secret Service */ }
  // Linux fallback for environments without Secret Service. Directory and file are owner-only.
  await writeFile(join(dataDir, "secrets.json"), JSON.stringify({ llmApiKey: secrets.llmApiKey }), { mode: 0o600 });
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
      return { llmApiKey: await runWithInput(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], encrypted) };
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
  await appendFile(join(dataDir, "runs.jsonl"), JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...entry }) + "\n");
}
