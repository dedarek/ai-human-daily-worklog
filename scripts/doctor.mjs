import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.cwd();
const dataDir = process.env.WORKLOG_DATA_DIR || (process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "Worklog")
  : process.platform === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Worklog")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "worklog"));
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

add("Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.version);
const whisperCli = process.env.WORKLOG_BUNDLED_WHISPER_CLI || (process.platform === "darwin" ? "/opt/homebrew/bin/whisper-cli" : "");
if (process.platform === "darwin") add("本地转写程序", existsSync(whisperCli), existsSync(whisperCli) ? whisperCli : "未安装");
try {
  const command = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
  const version = execFileSync(command, ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  add("飞书 CLI", true, version);
  const status = JSON.parse(execFileSync(command, ["auth", "status", "--json", "--verify"], { encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" } }));
  add("飞书用户认证", status.verified === true && status.identity === "user", status.identities?.user?.userName || status.identity || "未知身份");
} catch (error) { add("飞书 CLI / 认证", false, error.message); }

const settingsFile = join(dataDir, "settings.json");
if (existsSync(settingsFile)) {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  add("知识库目标", Boolean(settings.feishuWikiNodeToken), settings.feishuWikiNodeToken ? "已绑定" : "未绑定");
  add("LLM 配置", Boolean(settings.llmBaseUrl && settings.llmModel), settings.llmModel || "未配置");
  if (process.platform === "darwin") {
    add("Teams 音频检测器", existsSync(join(dataDir, "bin", "teams-audio-status")), existsSync(join(dataDir, "bin", "teams-audio-status")) ? "已生成" : "请运行 npm run build-native");
    add("系统音频采集器", existsSync(join(dataDir, "bin", "system-audio-capture")), existsSync(join(dataDir, "bin", "system-audio-capture")) ? "已生成" : "请运行 npm run build-native");
    const whisperModelPath = settings.whisperModelPath || join(dataDir, "models", "ggml-small.bin");
    add("Whisper 模型", existsSync(whisperModelPath), whisperModelPath);
  } else add("Teams 系统音频", true, "当前平台不要求；Agent、应用与报告功能可用");
} else add("项目配置", false, "请先启动服务并打开 http://127.0.0.1:4318");

for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
if (checks.some(check => !check.ok)) process.exitCode = 1;
