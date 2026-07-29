import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 4400 + Math.floor(Math.random() * 200);
const dataDir = await mkdtemp(join(tmpdir(), "worklog-smoke-"));
const child = spawn(process.execPath, ["dist/server.js"], {
  env: { ...process.env, WORKLOG_PORT: String(port), WORKLOG_DATA_DIR: dataDir, WORKLOG_DISABLE_BACKGROUND: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
child.stdout.on("data", chunk => output += chunk);
child.stderr.on("data", chunk => output += chunk);

try {
  let status;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) { status = await response.json(); break; }
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!status?.running) throw new Error(`server did not become ready\n${output}`);
  if (!status.capabilities?.platform) throw new Error("platform capabilities are missing");
  console.log(`✓ ${status.capabilities.platform} server smoke test on 127.0.0.1:${port}`);
} finally {
  child.kill();
}
