import test from "node:test";
import assert from "node:assert/strict";
import { defaultDataDir, platformCapabilities, worklogPlatform } from "../src/platform.js";

test("platform names are stable", () => {
  assert.equal(worklogPlatform("darwin"), "macos");
  assert.equal(worklogPlatform("win32"), "windows");
  assert.equal(worklogPlatform("linux"), "linux");
  assert.equal(worklogPlatform("freebsd"), "unsupported");
});

test("data directories follow each operating system convention", () => {
  assert.equal(defaultDataDir("darwin", {}, "/Users/demo"), "/Users/demo/Library/Application Support/Worklog");
  assert.equal(defaultDataDir("win32", { APPDATA: "C:\\Users\\demo\\AppData\\Roaming" }, "C:\\Users\\demo"), "C:\\Users\\demo\\AppData\\Roaming\\Worklog");
  assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: "/home/demo/.data" }, "/home/demo"), "/home/demo/.data/worklog");
});

test("Teams system audio is explicitly limited to macOS", () => {
  assert.equal(platformCapabilities("macos").teamsSystemAudio, true);
  assert.equal(platformCapabilities("windows").teamsSystemAudio, false);
  assert.equal(platformCapabilities("linux").teamsSystemAudio, false);
});
