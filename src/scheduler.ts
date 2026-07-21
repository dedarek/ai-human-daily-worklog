import cron, { type ScheduledTask } from "node-cron";
import { getSettings, logRun } from "./store.js";
import { run, runSummary } from "./reportRunner.js";
import { isoDate, dateAdd, previousMonth } from "./time.js";

let tasks: ScheduledTask[] = [];

export async function schedule() {
  for (const task of tasks) task.stop();
  tasks = [];
  const s = await getSettings();
  for (const [name, expr] of [["日报", s.schedule], ["周报", s.weeklySchedule], ["月报", s.monthlySchedule]] as const) {
    if (!cron.validate(expr)) throw new Error(`${name}定时规则无效：${expr}，请使用 5 段 cron，例如 10 0 * * *。`);
  }

  tasks.push(cron.schedule(s.schedule, () => {
    const date = isoDate(new Date(), s.timezone);
    run(date, true).catch(error => logRun({ status: "failed", date, error: String(error) }));
  }, { timezone: s.timezone }));

  tasks.push(cron.schedule(s.weeklySchedule, () => {
    const today = isoDate(new Date(), s.timezone);
    const start = dateAdd(today, -7); const end = dateAdd(today, -3);
    runSummary("weekly", start, end, true).catch(error => logRun({ status: "failed", kind: "weekly", start, end, error: String(error) }));
  }, { timezone: s.timezone }));

  tasks.push(cron.schedule(s.monthlySchedule, () => {
    const range = previousMonth(isoDate(new Date(), s.timezone));
    runSummary("monthly", range.start, range.end, true).catch(error => logRun({ status: "failed", kind: "monthly", ...range, error: String(error) }));
  }, { timezone: s.timezone }));
}
