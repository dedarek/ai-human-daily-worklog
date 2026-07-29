import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Secrets, Settings } from "./types.js";

const exec = promisify(execFile);
const legacyDataDir = join(process.cwd(), "data");
export const dataDir = process.env.WORKLOG_DATA_DIR || join(homedir(), "Library", "Application Support", "Worklog");
const settingsFile = join(dataDir, "settings.json");
const keychainService = "MacWorklogFeishu";

export const defaults: Settings = {
  schedule: "0 18 * * 1-5",
  weeklySchedule: "0 8 * * 1",
  monthlySchedule: "10 8 1 * *",
  timezone: "Asia/Shanghai",
  ignoredProcesses: ["Finder", "Control Center", "Notification Center", "Dock", "loginwindow", "WindowServer"],
  capturePaused: false,
  redactionEnabled: true,
  redactionTerms: [],
  llmBaseUrl: "https://api.openai.com/v1",
  llmProtocol: "openai",
  llmModel: "gpt-4.1-mini",
  larkCliPath: "",
  feishuBaseUrl: "https://feishu.cn",
  feishuWikiNodeToken: "",
  teamsMeetingEnabled: true,
  teamsAutoRecord: true,
  whisperCliPath: "/opt/homebrew/bin/whisper-cli",
  whisperModelPath: join(dataDir, "models", "ggml-small.bin"),
};

export async function setupStore() {
  await mkdir(dataDir, { recursive: true });
  if (dataDir === legacyDataDir || existsSync(join(dataDir, ".migration-complete")) || existsSync(join(dataDir, "settings.json"))) return;
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
export async function saveSecrets(secrets: Partial<Secrets>) {
  if (secrets.llmApiKey) await keychain("add-generic-password", "llm-api-key", secrets.llmApiKey);
}
export async function getSecrets(): Promise<Secrets> {
  const fetch = async (name: string) => { try { return await keychain("find-generic-password", name); } catch { return ""; } };
  return { llmApiKey: await fetch("llm-api-key") };
}
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export async function logRun(entry: object) {
  await setupStore();
  await appendFile(join(dataDir, "runs.jsonl"), JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...entry }) + "\n");
}
