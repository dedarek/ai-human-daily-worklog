import { homedir, platform as nodePlatform } from "node:os";
import { posix, win32 } from "node:path";

export type WorklogPlatform = "macos" | "windows" | "linux" | "unsupported";

export function worklogPlatform(value = nodePlatform()): WorklogPlatform {
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  if (value === "linux") return "linux";
  return "unsupported";
}

export function defaultDataDir(platform = nodePlatform(), env = process.env, home = homedir()) {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Worklog");
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Worklog");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "worklog");
}

export const platformCapabilities = (platform = worklogPlatform()) => ({
  platform,
  foregroundApps: platform !== "unsupported",
  agentLogs: platform !== "unsupported",
  teamsSystemAudio: platform === "macos",
  nativePermissions: platform === "macos",
});
