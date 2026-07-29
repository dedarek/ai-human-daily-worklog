import express from "express";
import { join } from "node:path";
import { registerRoutes } from "./routes.js";
import { schedule } from "./scheduler.js";
import { sampleOperation } from "./sampler.js";
import { getSettings, logRun, setupStore } from "./store.js";
import { startTeamsMonitor } from "./teamsMeeting.js";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(join(process.env.WORKLOG_ASSET_DIR || process.cwd(), "public")));
registerRoutes(app);

await setupStore();
if (process.env.WORKLOG_DISABLE_BACKGROUND !== "1") {
  await schedule();
  startTeamsMonitor();
}

const sample = () => getSettings().then(sampleOperation).catch(error => logRun({ status: "sample_failed", error: String(error) }));
if (process.env.WORKLOG_DISABLE_BACKGROUND !== "1") {
  setInterval(sample, 60_000);
  void sample();
}

const port = Number(process.env.WORKLOG_PORT || 4318);
app.listen(port, "127.0.0.1", () => console.log(`Worklog is running at http://127.0.0.1:${port}`));
