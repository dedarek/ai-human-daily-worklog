import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { dataDir } from "./store.js";
import { redact } from "./redact.js";
import type { Operation, Settings } from "./types.js";
import { getNativeState } from "./nativeBridge.js";

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

const windowsFrontmostApp = String.raw`
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WorklogWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$handle = [WorklogWindow]::GetForegroundWindow()
$title = New-Object Text.StringBuilder 1024
[void][WorklogWindow]::GetWindowText($handle, $title, $title.Capacity)
$pidValue = [uint32]0
[void][WorklogWindow]::GetWindowThreadProcessId($handle, [ref]$pidValue)
$name = try { (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch { "" }
@{ app = $name; windowTitle = $title.ToString() } | ConvertTo-Json -Compress
`;

async function macosFrontmostApp() {
  const native = getNativeState();
  if (native) return { app: native.app, windowTitle: native.windowTitle };
  try {
    const helper = join(dataDir, "bin", "permission-status");
    const command = existsSync(helper) ? helper : "/usr/bin/osascript";
    const args = existsSync(helper) ? ["--frontmost"] : ["-l", "JavaScript", "-e", frontmostApp];
    return JSON.parse((await exec(command, args, { timeout: 8000 })).stdout) as { app: string; windowTitle: string };
  } catch {
    const { stdout: asn } = await exec("/usr/bin/lsappinfo", ["front"], { timeout: 3000 });
    const { stdout: info } = await exec("/usr/bin/lsappinfo", ["info", "-only", "name", asn.trim()], { timeout: 3000 });
    return { app: info.match(/"LSDisplayName"="([^"]+)"/)?.[1] ?? "", windowTitle: "" };
  }
}

async function windowsForegroundApp() {
  const shell = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
  const { stdout } = await exec(shell, ["-NoProfile", "-NonInteractive", "-Command", windowsFrontmostApp], { timeout: 8000 });
  return JSON.parse(stdout.trim()) as { app: string; windowTitle: string };
}

async function linuxForegroundApp() {
  const tool = process.env.XDG_SESSION_TYPE === "wayland" ? "kdotool" : "xdotool";
  try {
    const id = (await exec(tool, ["getactivewindow"], { timeout: 3000 })).stdout.trim();
    const title = (await exec(tool, ["getwindowname", id], { timeout: 3000 })).stdout.trim();
    const pid = (await exec(tool, ["getwindowpid", id], { timeout: 3000 })).stdout.trim();
    let app = "";
    try { app = (await readFile(`/proc/${pid}/comm`, "utf8")).trim(); } catch { /* title remains useful */ }
    return { app: app || title.split(/\s[-—|]\s/).at(-1) || "Desktop", windowTitle: title };
  } catch {
    return { app: "", windowTitle: "" };
  }
}

export async function observeForegroundApp() {
  if (process.platform === "darwin") return macosFrontmostApp();
  if (process.platform === "win32") return windowsForegroundApp();
  if (process.platform === "linux") return linuxForegroundApp();
  return { app: "", windowTitle: "" };
}

export async function sampleOperation(settings: Settings): Promise<Operation | null> {
  if (settings.capturePaused) return null;
  if (!isWorkTime(settings.timezone)) return null;
  const observed = await observeForegroundApp();
  if (!observed.app || settings.ignoredProcesses.includes(observed.app)) return null;
  const timestamp = new Date().toISOString(); const date = dateIn(settings.timezone);
  const safe = (value: string) => settings.redactionEnabled ? redact(value, settings.redactionTerms) : value;
  const operation: Operation = { timestamp, app: safe(observed.app), windowTitle: safe(observed.windowTitle).slice(0, 300), evidenceId: `op-${timestamp.replace(/\D/g, "")}` };
  const dir = join(dataDir, "operations", date); await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "frontmost.jsonl"), JSON.stringify(operation) + "\n", { mode: 0o600 });
  return operation;
}
