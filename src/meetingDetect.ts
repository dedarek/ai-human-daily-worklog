// Teams 会议窗口/信号识别。保持为纯函数以便单测。
//
// 旧实现要求“会议/通话”前后必须是分隔符，导致中文标题“……中的会议”漏配。
// 现改为子串命中 + 负向列表排除（聊天、日历、通话记录等非会议视图），
// 自动开始优先依据 Teams 进程实际播放远端音频，会议窗口作为入会和静音阶段兜底。

export const MEETING_HINT = /会议|例会|周会|晨会|同步会|评审会|汇报会|分享会|讨论会|复盘会|通话|呼叫|正在开会|视频通话|语音通话|huddle|\bmeeting\b|\bcalling\b|\bin a call\b|\bcall with\b/i;

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
  teamsCallActive: boolean;
  meetingWindow: boolean;
};

export function hasMeetingSignal(signals: MeetingSignals): boolean {
  return signals.teamsCallActive || signals.meetingWindow;
}

const NOISE_WORDS = new Set([
  "you", "uh", "um", "ah", "oh", "hmm", "music", "applause",
  "thanks", "thank", "bye", "hello", "hi", "嗯", "啊", "哦", "呃",
]);

export function transcriptQuality(transcript: string): { valid: boolean; reason?: string } {
  const clean = transcript.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const content = clean.replace(/[^\p{L}\p{N}]/gu, "");
  if (content.length < 40) return { valid: false, reason: "有效语音内容不足" };

  const tokens = clean.toLocaleLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const dominant = Math.max(0, ...counts.values()) / Math.max(1, tokens.length);
  const diversity = counts.size / Math.max(1, tokens.length);
  const meaningfulLength = tokens.filter(token => !NOISE_WORDS.has(token)).join("").length;
  if (tokens.length >= 8 && (dominant > 0.55 || diversity < 0.12)) {
    return { valid: false, reason: "转写内容高度重复，疑似环境噪声" };
  }
  if (meaningfulLength < 30) return { valid: false, reason: "转写内容主要是口头语或识别噪声" };
  return { valid: true };
}
