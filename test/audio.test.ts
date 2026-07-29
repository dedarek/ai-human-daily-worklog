import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { peakVolumeDb, wavHeader } from "../src/teamsMeeting.js";

test("wavHeader describes 16 kHz mono PCM", () => {
  const header = wavHeader(32000);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.readUInt32LE(40), 32000);
});

test("peakVolumeDb measures PCM samples without FFmpeg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worklog-audio-"));
  const path = join(directory, "sample.wav");
  const samples = Buffer.alloc(8);
  samples.writeInt16LE(0, 0);
  samples.writeInt16LE(16384, 2);
  samples.writeInt16LE(-8192, 4);
  samples.writeInt16LE(0, 6);
  await writeFile(path, Buffer.concat([wavHeader(samples.length), samples]));
  assert.ok(Math.abs((await peakVolumeDb(path)) - -6.0206) < 0.01);
});
