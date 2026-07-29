# Worklog Privacy Model

Worklog is a local-first personal work archive. It is designed to make collection visible and controllable rather than operating as employee-monitoring software.

## Data collected locally

- frontmost application names and window titles during the configured work window;
- supported Agent task titles, user prompts, selected tool calls, commands, and file operations;
- explicitly captured terminal commands;
- on macOS, audio playback scoped to Microsoft Teams application processes, local transcripts, and useful meeting summaries;
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

Runtime data uses the operating system's standard per-user location: `~/Library/Application Support/Worklog/` on macOS, `%APPDATA%\\Worklog` on Windows, and `$XDG_DATA_HOME/worklog` (normally `~/.local/share/worklog`) on Linux.

LLM API keys use macOS Keychain, Windows DPAPI for the current user, or Linux Secret Service when available. On a headless Linux environment without Secret Service, Worklog falls back to an owner-only `secrets.json`; `WORKLOG_LLM_API_KEY` can be used instead to avoid that fallback. The legacy source-tree `data/` migration applies only to the default macOS data directory.

Worklog creates new runtime files with owner-only permissions and repairs permissions on data migrated from earlier versions. JSON state is written through a temporary file and atomic rename; malformed state is reported instead of silently replaced with empty defaults.

Automatic retention can be enabled in Settings. Operation evidence and processed meeting audio have independent retention periods; reports remain until the user deletes them. Retention is disabled when upgrading an existing installation so historical recordings are never deleted without an explicit choice.

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
- enable automatic cleanup and choose evidence/audio retention periods.

## Redaction

The shared redaction layer filters common API keys, bearer credentials, tokens, passwords, private keys, command-line secrets, and user-defined terms before window and terminal evidence is written, and before collected text is sent to an LLM. Raw meeting transcripts remain local; a redacted copy is used for summarization. Redaction reduces risk but cannot guarantee that every sensitive phrase will be recognized. Review the audit view and configure additional terms for your environment.

## Responsible deployment

Worklog is intended for a person's own device and work records. Before using it in an organization, confirm that collection and meeting transcription comply with workplace policy, confidentiality obligations, participant consent requirements, and applicable law.
