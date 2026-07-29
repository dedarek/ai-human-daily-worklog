# Product vision

Every tool keeps a log. People still finish the day without a coherent record of their own work.

That gap becomes larger when work is distributed across Agent sessions, sub-agents, terminals, meetings, pull requests, documents, and multiple models. Worklog exists to reconstruct that distributed work surface into a personal, durable work archive.

## The product loop

1. **Observe evidence** already produced by the user's tools.
2. **Recover context** across sessions, Agents, meetings, and artifacts.
3. **Distinguish work from noise** without measuring busyness.
4. **Explain outcomes** as projects, decisions, deliverables, risks, and current state.
5. **Let the user review and correct** what the system inferred.
6. **Archive and retrieve** the record in formats and destinations the user owns.
7. **Carry context forward** so tomorrow starts from today's actual state.

## Product principles

- **Artifact over activity**: a verified change, decision, document, or resolved problem matters more than how many windows were opened.
- **Context over chronology**: reports should explain a project, not replay a timeline.
- **Evidence without clutter**: important claims must remain traceable locally, while exported reports stay readable.
- **Human correction is product input**: edits should improve future project grouping and writing without uploading a hidden personal profile.
- **Local first and user owned**: raw work evidence stays local; exports use open formats and user-selected destinations.
- **Useful uncertainty**: when evidence is insufficient, say so or ask one focused question instead of inventing a conclusion.
- **Personal archive, not workplace surveillance**: Worklog serves the person doing the work.

## Highest-value unmet needs

### 1. Project and work graph

Recognize that three Agent sessions, two repositories, a meeting, and a document belong to the same project. Maintain project identity, goals, decisions, artifacts, people, risks, and open threads across days.

### 2. Intent → execution → result chains

Connect the original request to Agent actions, file changes, commits, CI, documents, and final outcomes. This is the difference between “commands were run” and “the release problem was solved and verified.”

### 3. Artifact-first outcome detection

Treat commits, pull requests, releases, documents, designs, deployments, and resolved issues as first-class work products. Use application activity only as supporting context.

### 4. Evidence trace and confidence

Allow a user to click a report sentence and see the local evidence that supports it, its source, and confidence. Low-confidence claims should be marked before publishing, not hidden behind fluent prose.

### 5. Review, correction, and local preference memory

Provide a pre-publish editor with sentence-level regeneration, project reassignment, omission, and comparison. Learn recurring project names, exclusions, and writing preferences from accepted corrections on-device.

### 6. Gap-aware daily close

Before 18:00 publishing, detect missing outcomes or ambiguous work and ask at most one or two focused questions. A 20-second correction can prevent a permanently wrong archive.

### 7. Morning continuation brief

Turn yesterday's archive into today's starting context: active projects, unresolved decisions, promised follow-ups, failed jobs, and the next concrete action. Worklog should reduce restart cost, not only document the past.

### 8. Personal archive search and synthesis

Answer questions such as “when did we decide this?”, “what changed after that meeting?”, and “what did I deliver for this project last quarter?” using the local archive with citations back to evidence.

### 9. Privacy and retention policies

Support per-app, project, meeting, and time-window rules; automatic raw-data expiration; summary-only mode; encrypted storage; and a visible preview of exactly what will leave the device.

### 10. Open evidence and plugin contracts

Define stable formats for evidence, artifacts, meetings, reports, and destinations. New Agent tools should be addable without modifying the core or granting broad access.

## Explicit non-goals

Worklog should not become:

- a keystroke, screenshot, or screen-recording tracker;
- an employee ranking or productivity-scoring system;
- a manager dashboard for monitoring individuals;
- a tool-call counter that rewards visible activity;
- a cloud service that requires uploading raw personal work history;
- an authoritative record when the available evidence is incomplete.
