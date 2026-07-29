import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseDir = process.env.WORKLOG_DATA_DIR || join(homedir(), "Library", "Application Support", "Worklog");
const dataDir = join(baseDir, "operations");
const [cwd = "", original = ""] = process.argv.slice(2);
let settings = {};
try { settings = JSON.parse(await readFile(join(baseDir, "settings.json"), "utf8")); } catch {}
if (settings.capturePaused === true) process.exit(0);
const redactSecrets = (text) => String(text ?? "")
  .replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
  .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*)[^\s;]+/gi, "$1[REDACTED]")
  .replace(/(--(?:api[_-]?key|token|secret|password)(?:=|\s+))[^\s]+/gi, "$1[REDACTED]");
const redact = (text) => {
  if (settings.redactionEnabled === false) return String(text ?? "");
  let result = redactSecrets(text);
  for (const term of (settings.redactionTerms || []).map(value => String(value).trim()).filter(value => value.length >= 2).slice(0, 50)) {
    result = result.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED_TERM]");
  }
  return result;
};
const now = new Date();
const date = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const command = redact(original).slice(0, 1200);
if (!command || command.includes("log-terminal-command.mjs")) process.exit(0);
const dir = join(dataDir, date); await mkdir(dir, { recursive: true });
await appendFile(join(dir, "terminal.jsonl"), JSON.stringify({ timestamp: now.toISOString(), cwd: redact(cwd).slice(0, 500), command, evidenceId: `cmd-${now.toISOString().replace(/\D/g, "")}` }) + "\n", { mode: 0o600 });
