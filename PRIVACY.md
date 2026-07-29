# Worklog Privacy Model

Worklog is a local-first personal work archive. It is designed to make collection visible and controllable rather than operating as employee-monitoring software.

## Data collected locally

- frontmost application names and window titles during the configured work window;
- supported Agent task titles, user prompts, selected tool calls, commands, and file operations;
- explicitly captured terminal commands;
- Microsoft Teams system playback audio, local transcripts, and useful meeting summaries;
- generated daily, weekly, and monthly reports;
- local configuration, run history, evidence manifests, and publishing indexes.

## Data not collected by default

- keystrokes;
- clipboard contents;
- screenshots or screen video;
- browser page bodies;
- microphone audio;
- hidden model reasoning;
- complete Agent tool output;
- activity outside the configured work window.

## Local storage

Runtime data is stored in `~/Library/Application Support/Worklog/`. LLM API keys are stored in macOS Keychain. The legacy source-tree `data/` directory is copied during migration and retained as a recoverable fallback until the user removes it.

## Remote transfers

Worklog does not run a Worklog-owned cloud service. When report generation is enabled, filtered text evidence and useful transcript excerpts are sent to the LLM endpoint configured by the user. When publishing is enabled, final reports are sent to the configured destination, currently Feishu.

Raw meeting audio is not sent to the LLM or publishing destination.

## User controls

- pause and resume all new collection;
- inspect today's filtered evidence before report generation;
- exclude applications;
- add custom sensitive terms;
- disable local Markdown export;
- choose the LLM endpoint, model, and publishing destination;
- keep Markdown reports in a user-controlled local directory.

## Redaction

The shared redaction layer filters common API keys, bearer credentials, tokens, passwords, private keys, command-line secrets, and user-defined terms before window and terminal evidence is written, and before collected text is sent to an LLM. Raw meeting transcripts remain local; a redacted copy is used for summarization. Redaction reduces risk but cannot guarantee that every sensitive phrase will be recognized. Review the audit view and configure additional terms for your environment.

## Responsible deployment

Worklog is intended for a person's own device and work records. Before using it in an organization, confirm that collection and meeting transcription comply with workplace policy, confidentiality obligations, participant consent requirements, and applicable law.
