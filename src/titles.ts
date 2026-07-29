// 飞书文档标题统一命名。集中在此避免各处格式漂移，纯函数便于单测。
// 统一风格：【类别】+ 空格 + 规范化日期（YYYY-MM-DD / YYYY-MM），会议附时间与主题。

export function dailyTitle(date: string) {
  return `【日报】${date}`;
}

export function weeklyTitle(start: string, end: string) {
  return `【周报】${start}~${end}`;
}

export function monthlyTitle(month: string) {
  // month 形如 2026-07-01 或 2026-07，统一取前 7 位。
  return `【月报】${month.slice(0, 7)}`;
}

export function meetingTitle(date: string, time: string, subject?: string) {
  const topic = (subject ?? "").trim();
  return `【会议记录】${date} ${time}${topic ? ` ${topic}` : ""}`;
}
