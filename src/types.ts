export type Settings = {
  schedule: string;
  weeklySchedule: string;
  monthlySchedule: string;
  timezone: string;
  ignoredProcesses: string[];
  llmBaseUrl: string;
  llmProtocol: "openai" | "anthropic";
  llmModel: string;
  larkCliPath?: string;
  feishuBaseUrl?: string;
  feishuWikiNodeToken?: string;
  teamsMeetingEnabled: boolean;
  teamsAutoRecord: boolean;
  teamsAudioDevice: string;
  teamsMicrophoneDevice: string;
  whisperCliPath: string;
  whisperModelPath: string;
};

export type Secrets = { llmApiKey: string };

export type Activity = {
  timestamp: string;
  process: string;
  subsystem?: string;
  category?: string;
  message: string;
  evidenceId: string;
};

export type Operation = { timestamp: string; app: string; windowTitle: string; evidenceId: string };

export type MeetingRecord = {
  id: string;
  provider: "Microsoft Teams";
  title: string;
  status: "recording" | "transcribing" | "summarizing" | "published" | "failed";
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  origin: "automatic" | "manual";
  audioPath?: string;
  transcriptPath?: string;
  reportPath?: string;
  transcriptPreview?: string;
  summaryPreview?: string;
  documentId?: string;
  url?: string;
  error?: string;
};
