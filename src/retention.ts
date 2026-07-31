import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./jsonStore.js";
import { dataDir, getSettings, logRun } from "./store.js";
import type { MeetingRecord } from "./types.js";

const dateName = /^\d{4}-\d{2}-\d{2}$/;
const before = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;

export async function cleanupRetention() {
  const settings = await getSettings();
  let removed = 0;
  const evidenceCutoff = before(settings.evidenceRetentionDays);
  if (settings.retentionEnabled) {
    for (const rootName of ["evidence", "operations"]) {
      const root = join(dataDir, rootName);
      if (!existsSync(root)) continue;
      for (const name of await readdir(root)) {
        if (!dateName.test(name) || Date.parse(`${name}T23:59:59Z`) >= evidenceCutoff) continue;
        await rm(join(root, name), { recursive: true, force: true }); removed++;
      }
    }
  }

  const meetings = await readJson<MeetingRecord[]>(join(dataDir, "meetings.json"), []);
  const audioCutoff = before(settings.meetingAudioRetentionDays);
  for (const meeting of meetings) {
    if (!["included", "ignored", "failed", "published"].includes(meeting.status) || !meeting.endedAt) continue;
    if (settings.retentionEnabled && Date.parse(meeting.endedAt) < audioCutoff && meeting.audioPath && existsSync(meeting.audioPath)) {
      await rm(meeting.audioPath, { force: true }); removed++;
    }
    if (settings.retentionEnabled && Date.parse(meeting.endedAt) < evidenceCutoff && meeting.transcriptPath && existsSync(meeting.transcriptPath)) {
      await rm(meeting.transcriptPath, { force: true }); removed++;
    }
  }

  // 无论是否启用按天清理，都清除崩溃留下的临时 PCM，并用硬上限阻止录音无限占满磁盘。
  const meetingsRoot = join(dataDir, "meetings");
  if (existsSync(meetingsRoot)) {
    const terminal = new Set(meetings.filter(item => ["included", "ignored", "failed", "published"].includes(item.status)).map(item => item.audioPath).filter(Boolean));
    const audioFiles: Array<{ path: string; size: number; mtimeMs: number; removable: boolean }> = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const info = await stat(path).catch(() => null); if (!info) continue;
          if ((entry.name.endsWith(".pcm") || entry.name.endsWith(".tmp")) && info.mtimeMs < Date.now() - 60 * 60_000) {
            await rm(path, { force: true }); removed++; continue;
          }
          if (entry.name.endsWith(".wav")) audioFiles.push({ path, size: info.size, mtimeMs: info.mtimeMs, removable: terminal.has(path) });
        }
      }
    };
    await walk(meetingsRoot);
    let total = audioFiles.reduce((sum, file) => sum + file.size, 0);
    const limit = settings.meetingStorageLimitMb * 1024 * 1024;
    for (const file of audioFiles.filter(file => file.removable).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= limit) break;
      await rm(file.path, { force: true }); total -= file.size; removed++;
    }
  }
  if (removed) await logRun({ status: "retention_cleanup", removed });
  return { enabled: settings.retentionEnabled, removed };
}
