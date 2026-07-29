# Contributing to Worklog

Thank you for helping build a trustworthy personal work archive for the AI-agent era.

## Before you start

- Search existing issues and discussions before opening a duplicate.
- For a new Agent, meeting platform, or publishing destination, describe the real workflow and example data format.
- Never attach real work logs, transcripts, credentials, customer names, or proprietary source code to an issue.
- For security or privacy vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Local development

Worklog currently targets macOS 13+ and Node.js 20+.

```bash
npm install
npm run build-native
npm run dev
```

Before submitting a change:

```bash
npm run check
npm test
node --check public/app.js
```

## Pull requests

- Keep each pull request focused on one problem.
- Explain the user impact, privacy impact, and validation performed.
- Add tests for parsing, date logic, redaction, report rendering, or destination behavior.
- Preserve local-first defaults. New remote transfers must be explicit, documented, and configurable.
- New collectors must be read-only toward the source application and must not ingest model reasoning or complete tool output by default.
- Fixtures must be synthetic and must not contain real credentials or personal data.

## Adding an Agent source

A collector should emit the shared `Activity` shape with a timestamp, source process, concise message, and stable evidence ID. Prefer user goals, task titles, file changes, commands, and tool names. Avoid assistant prose, hidden reasoning, large outputs, and duplicated events.

All extracted text must pass through the shared redaction layer before it is written to evidence or sent to an LLM.

## Adding a destination

Keep report generation independent from publishing. A destination should accept the final report, return a stable reference when possible, and be safe to retry without creating duplicates.
