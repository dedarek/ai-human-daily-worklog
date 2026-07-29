const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const port = Number(process.env.WORKLOG_PORT || 4318);
const endpoint = `http://127.0.0.1:${port}`;
let tray;
let window;
let quitting = false;

function platformDataDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || app.getPath("appData"), "Worklog");
  if (process.platform === "linux") return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "worklog");
  return path.join(app.getPath("appData"), "Worklog");
}

async function request(url, options) {
  const response = await fetch(`${endpoint}${url}`, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { return await request("/api/status"); }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw lastError || new Error("Worklog 后台服务没有启动。");
}

async function startServer() {
  process.env.WORKLOG_DATA_DIR ||= platformDataDir();
  process.env.WORKLOG_ASSET_DIR ||= app.getAppPath();
  process.env.WORKLOG_BUNDLED_LARK_CLI ||= path.join(app.getAppPath(), "node_modules", "@larksuite", "cli", "scripts", "run.js");
  await import(pathToFileURL(path.join(app.getAppPath(), "dist", "server.js")).href);
  await waitForServer();
}

function showPage(route = "/") {
  if (!window) return;
  window.loadURL(`${endpoint}${route}`);
  window.show();
  window.focus();
}

async function openToday() {
  try {
    const status = await request("/api/menu/status");
    if (status.todayUrl) return shell.openExternal(status.todayUrl);
  } catch { /* dashboard is the safe fallback */ }
  showPage("/");
}

async function setPaused(paused) {
  await request("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
  await rebuildMenu();
}

async function runDaily() {
  tray?.setToolTip("Worklog · 正在生成日报");
  try { await request("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }); }
  finally { await rebuildMenu(); }
}

async function rebuildMenu() {
  let status = { capturePaused: false, setupReady: false };
  try { status = await request("/api/menu/status"); } catch { /* keep recovery actions available */ }
  tray?.setToolTip(status.capturePaused ? "Worklog · 已暂停" : "Worklog · 正在记录");
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: status.capturePaused ? "状态：已暂停" : "状态：正在记录", enabled: false },
    { type: "separator" },
    { label: "打开 Worklog", click: () => showPage(status.setupReady ? "/" : "/setup.html") },
    { label: status.capturePaused ? "恢复记录" : "暂停记录", click: () => void setPaused(!status.capturePaused) },
    { label: "立即生成今天日报", enabled: status.setupReady, click: () => void runDaily() },
    { label: "打开今天文档", enabled: status.setupReady, click: () => void openToday() },
    { type: "separator" },
    { label: "退出 Worklog", click: () => { quitting = true; app.quit(); } },
  ]));
}

async function enableLinuxAutostart() {
  if (process.platform !== "linux" || !app.isPackaged) return;
  const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
  await mkdir(directory, { recursive: true });
  const executable = process.env.APPIMAGE || process.execPath;
  const escaped = executable.replace(/([\\"`$])/g, "\\$1");
  await writeFile(path.join(directory, "worklog.desktop"), `[Desktop Entry]\nType=Application\nName=Worklog\nComment=AI work journal\nExec="${escaped}" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
}

async function createDesktop() {
  const iconPath = path.join(app.getAppPath(), "desktop", "icon.png");
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.on("click", () => showPage("/"));
  window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    show: false,
    title: "Worklog",
    icon,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.on("close", event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  await rebuildMenu();
  const setup = await request("/api/onboarding/status").catch(() => ({ complete: false }));
  if (!process.argv.includes("--hidden")) showPage(setup.complete ? "/" : "/setup.html");
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => showPage("/"));
  app.on("before-quit", () => { quitting = true; });
  app.whenReady().then(async () => {
    app.setAppUserModelId("dev.worklog.desktop");
    if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    await enableLinuxAutostart();
    await startServer();
    await createDesktop();
    setInterval(() => void rebuildMenu(), 15_000);
  }).catch(error => {
    const { dialog } = require("electron");
    dialog.showErrorBox("Worklog 无法启动", String(error?.stack || error));
    app.quit();
  });
}
