export type Settings = {
  schedule: string;
  weeklySchedule: string;
  monthlySchedule: string;
  morningSchedule: string;
  timezone: string;
  ignoredProcesses: string[];
  capturePaused: boolean;
  redactionEnabled: boolean;
  redactionTerms: string[];
  markdownOutputEnabled: boolean;
  markdownOutputDir: string;
  llmBaseUrl: string;
  llmProtocol: "openai" | "anthropic";
  llmModel: string;
  larkCliPath?: string;
  feishuBaseUrl?: string;
  feishuWikiNodeToken?: string;
  teamsMeetingEnabled: boolean;
  teamsAutoRecord: boolean;
  whisperCliPath: string;
  whisperModelPath: string;
  retentionEnabled: boolean;
  evidenceRetentionDays: number;
  meetingAudioRetentionDays: number;
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

export type ArtifactType = "commit" | "pull_request" | "release" | "document" | "file" | "build" | "test" | "deployment" | "decision";

export type WorkArtifact = {
  id: string;
  type: ArtifactType;
  title: string;
  timestamp: string;
  projectId: string;
  evidenceIds: string[];
  verified: boolean;
  reference?: string;
};

export type WorkChain = {
  id: string;
  projectId: string;
  title: string;
  intent?: { summary: string; evidenceId: string; timestamp: string };
  steps: Array<{ summary: string; evidenceId: string; timestamp: string }>;
  artifacts: WorkArtifact[];
  outcome: string;
  status: "verified" | "produced" | "in_progress" | "uncertain";
  confidence: number;
};

export type WorkProject = {
  id: string;
  name: string;
  aliases: string[];
  evidenceIds: string[];
  artifacts: WorkArtifact[];
  chains: WorkChain[];
  firstSeenAt: string;
  lastSeenAt: string;
};

export type WorkGraph = {
  date: string;
  generatedAt: string;
  projects: WorkProject[];
  unassignedEvidenceIds: string[];
};

export type EvidenceClaim = {
  id: string;
  section: string;
  text: string;
  projectId?: string;
  evidenceIds: string[];
  confidence: number;
};

export type ReportTrace = { date: string; generatedAt: string; claims: EvidenceClaim[] };

export type GapQuestion = { id: string; projectId: string; question: string; reason: string; evidenceIds: string[] };

export type DailyDraft = {
  date: string;
  status: "draft" | "published";
  version: number;
  createdAt: string;
  updatedAt: string;
  originalReport: string;
  editedReport: string;
  graph: WorkGraph;
  trace: ReportTrace;
  gaps: GapQuestion[];
  answers: Record<string, string>;
  events: number;
  manifest?: unknown;
  published?: { documentId?: string; url?: string; title?: string };
};

export type Operation = { timestamp: string; app: string; windowTitle: string; evidenceId: string };

export type MeetingRecord = {
  id: string;
  provider: "Microsoft Teams";
  title: string;
  status: "recording" | "transcribing" | "summarizing" | "included" | "ignored" | "published" | "failed";
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
