import express from "express";
import { join } from "node:path";
import { registerRoutes } from "./routes.js";
import { schedule, stopSchedule } from "./scheduler.js";
import { sampleOperation } from "./sampler.js";
import { getSettings, logRun, setupStore } from "./store.js";
import { startTeamsMonitor, stopTeamsMonitor } from "./teamsMeeting.js";
import { jsonErrorHandler, localSecurity } from "./security.js";
import { cleanupRetention } from "./retention.js";

process.umask(0o077);

const app = express();
app.disable("x-powered-by");
app.use(localSecurity);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(join(process.env.WORKLOG_ASSET_DIR || process.cwd(), "public")));
registerRoutes(app);
app.use(jsonErrorHandler);

// 先占用端口再启动 cron/采样器，避免两个桌面实例在端口竞争期间同时运行后台任务。
const port = Number(process.env.WORKLOG_PORT || 4318);
const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
  const candidate = app.listen(port, "127.0.0.1");
  candidate.once("listening", () => resolve(candidate));
  candidate.once("error", reject);
});
console.log(`Worklog is running at http://127.0.0.1:${port}`);

await setupStore();
await cleanupRetention().catch(error => logRun({ status: "retention_failed", error: String(error) }));
if (process.env.WORKLOG_DISABLE_BACKGROUND !== "1") {
  await schedule();
  await startTeamsMonitor();
}

const sample = () => getSettings().then(sampleOperation).catch(error => logRun({ status: "sample_failed", error: String(error) }));
if (process.env.WORKLOG_DISABLE_BACKGROUND !== "1") {
  const sampleTimer = setInterval(sample, 60_000); sampleTimer.unref();
  const retentionTimer = setInterval(() => void cleanupRetention().catch(error => logRun({ status: "retention_failed", error: String(error) })), 24 * 60 * 60_000); retentionTimer.unref();
  void sample();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  stopSchedule();
  await stopTeamsMonitor().catch(error => logRun({ status: "shutdown_meeting_failed", error: String(error) }));
  await new Promise<void>(resolve => server.close(() => resolve()));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown().finally(() => process.exit()));
