import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 4400 + Math.floor(Math.random() * 200);
const dataDir = await mkdtemp(join(tmpdir(), "worklog-smoke-"));
await mkdir(join(dataDir, "reports"), { recursive: true });
await writeFile(join(dataDir, "reports", "2026-07-30.md"), "# 2026-07-30 工作日志\n\n## 项目进展与产出\n\nWorklog 完成了跨平台安装包验证。\n");
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
      if (response.ok) {
        if (!response.headers.get("content-security-policy") || response.headers.has("x-powered-by")) throw new Error("local API security headers are missing");
        status = await response.json(); break;
      }
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!status?.running) throw new Error(`server did not become ready\n${output}`);
  if (!status.capabilities?.platform) throw new Error("platform capabilities are missing");
  if (!status.morningSchedule) throw new Error("morning schedule is missing");
  const traversal = await fetch(`http://127.0.0.1:${port}/api/work-graph?date=${encodeURIComponent("../../escape")}`);
  if (traversal.status !== 400) throw new Error("date path traversal was not rejected");
  const csrf = await fetch(`http://127.0.0.1:${port}/api/capture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (csrf.status !== 403) throw new Error("unmarked local API mutation was not rejected");
  const graphResponse = await fetch(`http://127.0.0.1:${port}/api/work-graph?date=2026-07-30`);
  if (!graphResponse.ok || !(await graphResponse.json()).projects) throw new Error("work graph endpoint failed");
  const searchResponse = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent("跨平台安装包")}`);
  const search = await searchResponse.json();
  if (!searchResponse.ok || !search.results?.length) throw new Error("archive search endpoint failed");
  const draftResponse = await fetch(`http://127.0.0.1:${port}/api/draft?date=2026-07-30`);
  if (draftResponse.status !== 404) throw new Error("missing draft must return 404");
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  for (const id of ["workGraph", "draftEditor", "morning", "archiveQuery", "trace"]) if (!page.includes(`id="${id}"`)) throw new Error(`UI is missing ${id}`);
  console.log(`✓ ${status.capabilities.platform} server, archive, graph and review UI smoke test on 127.0.0.1:${port}`);
} finally {
  child.kill();
}
