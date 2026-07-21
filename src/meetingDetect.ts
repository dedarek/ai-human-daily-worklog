// Teams 会议窗口/信号识别。保持为纯函数以便单测。
//
// 旧实现要求“会议/通话”前后必须是分隔符，导致中文标题“……中的会议”漏配。
// 现改为子串命中 + 负向列表排除（聊天、日历、通话记录等非会议视图），
// 并配合音频与通话辅助进程等多个信号综合判定，降低对单一标题规则的依赖。

export const MEETING_HINT = /会议|通话|呼叫|正在开会|视频通话|语音通话|huddle|\bmeeting\b|\bcalling\b|\bin a call\b|\bcall with\b/i;

export const NON_MEETING = /记录|历史|history|聊天|\bchat\b|日历|calendar|活动|\bactivity\b|通知|notification|设置|\bsettings\b/i;

export function isMeetingTitle(title: string): boolean {
  const s = (title ?? "").trim();
  if (!s || !MEETING_HINT.test(s)) return false;
  if (NON_MEETING.test(s)) return false;
  return true;
}

export function isMeetingWindow(titles: string[]): boolean {
  return titles.some(isMeetingTitle);
}

export type MeetingSignals = {
  audioRunning: boolean;
  meetingWindow: boolean;
  callHelper: boolean;
};

export function hasMeetingSignal(signals: MeetingSignals): boolean {
  return signals.audioRunning || signals.meetingWindow || signals.callHelper;
}
