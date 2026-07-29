import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.cwd();
const dataDir = process.env.WORKLOG_DATA_DIR || join(homedir(), "Library", "Application Support", "Worklog");
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

add("Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.version);
const whisperCli = process.env.WORKLOG_BUNDLED_WHISPER_CLI || "/opt/homebrew/bin/whisper-cli";
add("本地转写程序", existsSync(whisperCli), existsSync(whisperCli) ? whisperCli : "未安装");
try {
  const version = execFileSync("/bin/zsh", ["-lc", "lark-cli --version"], { encoding: "utf8" }).trim();
  add("飞书 CLI", true, version);
  const status = JSON.parse(execFileSync("/bin/zsh", ["-lc", "LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli auth status --json --verify"], { encoding: "utf8" }));
  add("飞书用户认证", status.verified === true && status.identity === "user", status.identities?.user?.userName || status.identity || "未知身份");
} catch (error) { add("飞书 CLI / 认证", false, error.message); }

const settingsFile = join(dataDir, "settings.json");
if (existsSync(settingsFile)) {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  add("知识库目标", Boolean(settings.feishuWikiNodeToken), settings.feishuWikiNodeToken ? "已绑定" : "未绑定");
  add("LLM 配置", Boolean(settings.llmBaseUrl && settings.llmModel), settings.llmModel || "未配置");
  add("Teams 音频检测器", existsSync(join(dataDir, "bin", "teams-audio-status")), existsSync(join(dataDir, "bin", "teams-audio-status")) ? "已生成" : "请运行 npm run build-native");
  add("系统音频采集器", existsSync(join(dataDir, "bin", "system-audio-capture")), existsSync(join(dataDir, "bin", "system-audio-capture")) ? "已生成" : "请运行 npm run build-native");
  const whisperModelPath = settings.whisperModelPath || join(dataDir, "models", "ggml-small.bin");
  add("Whisper 模型", existsSync(whisperModelPath), whisperModelPath);
} else add("项目配置", false, "请先启动服务并打开 http://127.0.0.1:4318");

for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
if (checks.some(check => !check.ok)) process.exitCode = 1;
