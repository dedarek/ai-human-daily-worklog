export function isoDate(date = new Date(), timezone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function dateAdd(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function previousDay() {
  return dateAdd(isoDate(), -1);
}

export function workdays(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = dateAdd(date, 1)) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day >= 1 && day <= 5) dates.push(date);
  }
  return dates;
}

export function previousMonth(date: string) {
  const current = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  current.setUTCMonth(current.getUTCMonth() - 1);
  const start = current.toISOString().slice(0, 10);
  current.setUTCMonth(current.getUTCMonth() + 1);
  current.setUTCDate(0);
  return { start, end: current.toISOString().slice(0, 10), month: start.slice(0, 7) };
}

export function inHourWindow(timestamp: string, timezone: string, startHour: number, endHour: number) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? 0);
  const total = hour * 60 + minute;
  return total >= startHour * 60 && total <= endHour * 60;
}
