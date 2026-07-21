import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Secrets, Settings } from "./types.js";

const exec = promisify(execFile);
export const dataDir = join(process.cwd(), "data");
const settingsFile = join(dataDir, "settings.json");
const keychainService = "MacWorklogFeishu";

export const defaults: Settings = {
  schedule: "0 18 * * 1-5",
  timezone: "Asia/Shanghai",
  ignoredProcesses: ["Finder", "Control Center", "Notification Center", "Dock", "loginwindow", "WindowServer"],
  llmBaseUrl: "https://api.openai.com/v1",
  llmProtocol: "openai",
  llmModel: "gpt-4.1-mini",
  larkCliPath: "",
  feishuBaseUrl: "https://feishu.cn",
  feishuWikiNodeToken: "",
  titlePrefix: "工作日志",
  teamsMeetingEnabled: true,
  teamsAutoRecord: true,
  teamsAudioDevice: "Microsoft Teams Audio",
  teamsMicrophoneDevice: "",
  whisperCliPath: "/opt/homebrew/bin/whisper-cli",
  whisperModelPath: join(dataDir, "models", "ggml-small.bin"),
};

export async function setupStore() { await mkdir(dataDir, { recursive: true }); }
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
