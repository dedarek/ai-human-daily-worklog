export type Settings = {
  schedule: string;
  timezone: string;
  ignoredProcesses: string[];
  llmBaseUrl: string;
  llmProtocol: "openai" | "anthropic";
  llmModel: string;
  larkCliPath?: string;
  feishuBaseUrl?: string;
  feishuWikiNodeToken?: string;
  titlePrefix: string;
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
