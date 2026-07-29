import cron, { type ScheduledTask } from "node-cron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSettings, logRun, dataDir } from "./store.js";
import { readJson } from "./jsonStore.js";
import { run, runSummary } from "./reportRunner.js";
import { createMorningBrief } from "./morningBrief.js";
import { isoDate, dateAdd, previousMonth, workdays } from "./time.js";

let tasks: ScheduledTask[] = [];

function localWeekday(date: Date, timezone: string) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function previousWorkWeek(today: string, timezone: string) {
  const weekday = localWeekday(new Date(`${today}T12:00:00Z`), timezone);
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  const monday = dateAdd(today, -mondayOffset);
  return { start: dateAdd(monday, -7), end: dateAdd(monday, -3) };
}

async function hasEvidence(date: string) {
  return [join(dataDir, "evidence", date), join(dataDir, "operations", date)].some(existsSync);
}

function hasReports(start: string, end: string) {
  return workdays(start, end).some(date => existsSync(join(dataDir, "reports", `${date}.md`)));
}

async function catchUp(now: Date, timezone: string) {
  const published = await readJson<Record<string, unknown>>(join(dataDir, "published.json"), {});
  const today = isoDate(now, timezone);
  const weekday = localWeekday(now, timezone);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
  const minute = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, minute: "2-digit" }).format(now));
  const tasksToRun: Array<() => Promise<unknown>> = [];

  const afterMorning = hour > 8 || (hour === 8 && minute >= 30);
  if (weekday >= 1 && weekday <= 5 && afterMorning && hasReports(dateAdd(today, -7), dateAdd(today, -1)) && !existsSync(join(dataDir, "briefs", `${today}.md`))) tasksToRun.push(() => createMorningBrief(today, false));

  const dailyEnd = hour > 18 || (hour === 18 && minute >= 0);
  if (dailyEnd) {
    for (const date of workdays(dateAdd(today, -7), dateAdd(today, -1))) {
      if (!published[date] && await hasEvidence(date)) tasksToRun.push(() => run(date, false));
    }
    if (weekday >= 1 && weekday <= 5 && !published[today] && await hasEvidence(today)) tasksToRun.push(() => run(today, false));
  }

  const afterWeekly = hour > 8 || (hour === 8 && minute >= 0);
  if (weekday >= 1 && afterWeekly) {
    const range = previousWorkWeek(today, timezone);
    if (!published[`weekly:${range.start}`] && hasReports(range.start, range.end)) tasksToRun.push(() => runSummary("weekly", range.start, range.end, false));
  }

  const day = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "2-digit" }).format(now));
  const afterMonthly = hour > 8 || (hour === 8 && minute >= 10);
  if (day >= 1 && afterMonthly) {
    const range = previousMonth(today);
    if (!published[`monthly:${range.start.slice(0, 7)}`] && hasReports(range.start, range.end)) tasksToRun.push(() => runSummary("monthly", range.start, range.end, false));
  }

  for (const task of tasksToRun) {
    try { await task(); } catch (error) { await logRun({ status: "catchup_failed", error: String(error) }); }
  }
}

export async function schedule() {
  for (const task of tasks) task.stop();
  tasks = [];
  const s = await getSettings();
  for (const [name, expr] of [["日报", s.schedule], ["周报", s.weeklySchedule], ["月报", s.monthlySchedule], ["晨间续接", s.morningSchedule]] as const) {
    if (!cron.validate(expr)) throw new Error(`${name}定时规则无效：${expr}，请使用 5 段 cron，例如 10 0 * * *。`);
  }

  tasks.push(cron.schedule(s.schedule, () => {
    const date = isoDate(new Date(), s.timezone);
    run(date, false).catch(error => logRun({ status: "failed", date, error: String(error) }));
  }, { timezone: s.timezone }));

  tasks.push(cron.schedule(s.weeklySchedule, () => {
    const today = isoDate(new Date(), s.timezone);
    const { start, end } = previousWorkWeek(today, s.timezone);
    runSummary("weekly", start, end, false).catch(error => logRun({ status: "failed", kind: "weekly", start, end, error: String(error) }));
  }, { timezone: s.timezone }));

  tasks.push(cron.schedule(s.monthlySchedule, () => {
    const range = previousMonth(isoDate(new Date(), s.timezone));
    runSummary("monthly", range.start, range.end, false).catch(error => logRun({ status: "failed", kind: "monthly", ...range, error: String(error) }));
  }, { timezone: s.timezone }));

  tasks.push(cron.schedule(s.morningSchedule, () => {
    const date = isoDate(new Date(), s.timezone);
    createMorningBrief(date, false).catch(error => logRun({ status: "failed", kind: "morning", date, error: String(error) }));
  }, { timezone: s.timezone }));

  void catchUp(new Date(), s.timezone);
}
