import express from "express";
import { join } from "node:path";
import { registerRoutes } from "./routes.js";
import { schedule } from "./scheduler.js";
import { sampleOperation } from "./sampler.js";
import { getSettings, logRun, setupStore } from "./store.js";
import { startTeamsMonitor } from "./teamsMeeting.js";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(join(process.cwd(), "public")));
registerRoutes(app);

await setupStore();
await schedule();
startTeamsMonitor();

const sample = () => getSettings().then(sampleOperation).catch(error => logRun({ status: "sample_failed", error: String(error) }));
setInterval(sample, 60_000);
void sample();

app.listen(4318, "127.0.0.1", () => console.log("Worklog is running at http://127.0.0.1:4318"));
