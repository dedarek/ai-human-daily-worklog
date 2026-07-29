import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { dataDir } from "./store.js";
import { redact } from "./redact.js";
import type { Operation, Settings } from "./types.js";

const exec = promisify(execFile);
const dateIn = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
function isWorkTime(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const weekday = parts.find(part => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? 0);
  const total = hour * 60 + minute;
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday) && total >= 8 * 60 && total <= 18 * 60;
}
const frontmostApp = `
  const se = Application('System Events');
  const apps = se.processes.whose({frontmost: true})();
  if (!apps.length) { JSON.stringify({app:'', windowTitle:''}); }
  else { const app = apps[0]; let title = ''; try { title = app.windows[0].name(); } catch (_) {} JSON.stringify({app: app.name(), windowTitle: title}); }
`;

export async function sampleOperation(settings: Settings): Promise<Operation | null> {
  if (settings.capturePaused) return null;
  if (!isWorkTime(settings.timezone)) return null;
  let observed: { app: string; windowTitle: string };
  try {
    const helper = join(dataDir, "bin", "permission-status");
    const command = existsSync(helper) ? helper : "/usr/bin/osascript";
    const args = existsSync(helper) ? ["--frontmost"] : ["-l", "JavaScript", "-e", frontmostApp];
    const { stdout } = await exec(command, args, { timeout: 8000 });
    observed = JSON.parse(stdout) as { app: string; windowTitle: string };
  } catch {
    const { stdout: asn } = await exec("/usr/bin/lsappinfo", ["front"], { timeout: 3000 });
    const { stdout: info } = await exec("/usr/bin/lsappinfo", ["info", "-only", "name", asn.trim()], { timeout: 3000 });
    observed = { app: info.match(/"LSDisplayName"="([^"]+)"/)?.[1] ?? "", windowTitle: "" };
  }
  if (!observed.app || settings.ignoredProcesses.includes(observed.app)) return null;
  const timestamp = new Date().toISOString(); const date = dateIn(settings.timezone);
  const safe = (value: string) => settings.redactionEnabled ? redact(value, settings.redactionTerms) : value;
  const operation: Operation = { timestamp, app: safe(observed.app), windowTitle: safe(observed.windowTitle).slice(0, 300), evidenceId: `op-${timestamp.replace(/\D/g, "")}` };
  const dir = join(dataDir, "operations", date); await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "frontmost.jsonl"), JSON.stringify(operation) + "\n", { mode: 0o600 });
  return operation;
}
