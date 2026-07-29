import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(process.env.WORKLOG_DATA_DIR || join(homedir(), "Library", "Application Support", "Worklog"), "operations");
const [cwd = "", original = ""] = process.argv.slice(2);
const redact = (text) => text
  .replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
  .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*)[^\s;]+/gi, "$1[REDACTED]")
  .replace(/(--(?:api[_-]?key|token|secret|password)(?:=|\s+))[^\s]+/gi, "$1[REDACTED]");
const now = new Date();
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const command = redact(original).slice(0, 1200);
if (!command || command.includes("log-terminal-command.mjs")) process.exit(0);
const dir = join(dataDir, date); await mkdir(dir, { recursive: true });
await appendFile(join(dir, "terminal.jsonl"), JSON.stringify({ timestamp: now.toISOString(), cwd: redact(cwd).slice(0, 500), command, evidenceId: `cmd-${now.toISOString().replace(/\D/g, "")}` }) + "\n", { mode: 0o600 });
