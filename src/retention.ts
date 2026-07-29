import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./jsonStore.js";
import { dataDir, getSettings, logRun } from "./store.js";
import type { MeetingRecord } from "./types.js";

const dateName = /^\d{4}-\d{2}-\d{2}$/;
const before = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;

export async function cleanupRetention() {
  const settings = await getSettings();
  if (!settings.retentionEnabled) return { enabled: false, removed: 0 };
  let removed = 0;
  const evidenceCutoff = before(settings.evidenceRetentionDays);
  for (const rootName of ["evidence", "operations"]) {
    const root = join(dataDir, rootName);
    if (!existsSync(root)) continue;
    for (const name of await readdir(root)) {
      if (!dateName.test(name) || Date.parse(`${name}T23:59:59Z`) >= evidenceCutoff) continue;
      await rm(join(root, name), { recursive: true, force: true }); removed++;
    }
  }

  const meetings = await readJson<MeetingRecord[]>(join(dataDir, "meetings.json"), []);
  const audioCutoff = before(settings.meetingAudioRetentionDays);
  for (const meeting of meetings) {
    if (!["included", "ignored", "failed", "published"].includes(meeting.status) || !meeting.endedAt) continue;
    if (Date.parse(meeting.endedAt) < audioCutoff && meeting.audioPath && existsSync(meeting.audioPath)) {
      await rm(meeting.audioPath, { force: true }); removed++;
    }
    if (Date.parse(meeting.endedAt) < evidenceCutoff && meeting.transcriptPath && existsSync(meeting.transcriptPath)) {
      await rm(meeting.transcriptPath, { force: true }); removed++;
    }
  }
  if (removed) await logRun({ status: "retention_cleanup", removed });
  return { enabled: true, removed };
}
