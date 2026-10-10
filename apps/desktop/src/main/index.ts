import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  systemPreferences,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  grabScreenshot,
  listScreenSources,
  noteHudMotion,
  setHudOcclusion,
  startScreenWatch,
  stopScreenWatch,
} from "./screenCapture";
import { detectMeetingApp } from "./meetingApps";
import {
  attachShortcutHandlers,
  getSettings,
  isOnboarded,
  loadSettings,
  markOnboarded,
  resetShortcuts,
  setSessionActive,
  updateSettings,
} from "./appSettings";
import {
  canQueryMediaAccess,
  chromeWindowExtras,
  clampHud,
  isWaylandSession,
  loopbackAudio,
  preferenceUrls,
  screenCaptureMode,
  shouldRelaunchUnderXWayland,
} from "../compat";
import {
  attachHudOverlay,
  hudWindowOptions,
  nudgeHud,
  setHudKeyboard,
  setOverlaySession,
  showHudInactive,
  toggleHudInteract,
} from "./overlayWindow";
import { PRODUCTION_HTTP, PRODUCTION_WS } from "../remote";

app.setName("Bana Copilot");

if (shouldRelaunchUnderXWayland(process.platform, process.env, process.argv)) {
  app.relaunch({
    execPath: process.env.APPIMAGE || process.execPath,
    args: [...process.argv.slice(1), "--ozone-platform=x11"],
  });
  app.exit(0);
} else if (isWaylandSession(process.platform, process.env)) {
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}

const STREAM_CAPTURE = screenCaptureMode(process.platform, process.env) === "stream";

let win: BrowserWindow | null = null;
let homeWin: BrowserWindow | null = null;
let onboardWin: BrowserWindow | null = null;
let hidden = true;
let collapsed = true;
let menuOpen = false;
let displayIndex = 0;
let quitting = false;

const COLLAPSED = { width: 520, height: 96 };
const EXPANDED = { width: 780, height: 520 };
const LOCAL_HTTP = "http://127.0.0.1:8787";
const LOCAL_WS = "ws://127.0.0.1:8787/ws";
let HTTP = LOCAL_HTTP;
let WS = LOCAL_WS;

function wsFromHttp(http: string) {
  const parsed = new URL(http);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function sanitizeApiBase(raw: string) {
  const parsed = new URL(String(raw ?? "").trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Use an http or https API URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not put credentials in the URL.");
  }
  return parsed.origin;
}

function remoteFile() {
  return path.join(app.getPath("userData"), "api.json");
}

function applyRemote() {
  if (process.env.MEETING_COPILOT_HTTP) {
    HTTP = process.env.MEETING_COPILOT_HTTP;
    WS = process.env.MEETING_COPILOT_API ?? wsFromHttp(HTTP);
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(remoteFile(), "utf8")) as { http?: string };
    if (saved.http) {
      HTTP = sanitizeApiBase(saved.http);
      WS = wsFromHttp(HTTP);
      return;
    }
  } catch {
    /* no override */
  }
  if (app.isPackaged && PRODUCTION_HTTP && !PRODUCTION_HTTP.includes("[IP_ADDRESS]")) {
    HTTP = PRODUCTION_HTTP;
    WS = PRODUCTION_WS || wsFromHttp(PRODUCTION_HTTP);
    return;
  }
  HTTP = LOCAL_HTTP;
  WS = LOCAL_WS;
}

function listName() {
  return app.isPackaged ? "Bana Copilot" : "Electron";
}

function hudSize() {
  if (menuOpen) {
    return collapsed ? { width: COLLAPSED.width, height: 320 } : EXPANDED;
  }
  return collapsed ? COLLAPSED : EXPANDED;
}

function resizeHud(size = hudSize()) {
  if (!win) return;
  try {
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const fit = {
      width: Math.min(size.width, display.workArea.width - 16),
      height: Math.min(size.height, display.workArea.height - 16),
    };
    const pos = clampHud(bounds.x + bounds.width - fit.width, bounds.y, fit, display.workArea);
    win.setBounds({ ...pos, ...fit });
    syncHudGeometry();
  } catch (err) {
    console.error("[hud] resize failed", err);
  }
}

function placeOnDisplay(index: number, size = hudSize()) {
  if (!win) return;
  try {
    const displays = screen.getAllDisplays();
    if (!displays.length) return;
    displayIndex = ((index % displays.length) + displays.length) % displays.length;
    const display = displays[displayIndex];
    const x = display.workArea.x + display.workArea.width - size.width - 24;
    const y = display.workArea.y + 48;
    const pos = clampHud(x, y, size, display.workArea);
    win.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    syncHudGeometry();
  } catch (err) {
    console.error("[hud] place failed", err);
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...COLLAPSED,
    ...hudWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [
        `--copilot-api=${WS}`,
        `--copilot-http=${HTTP}`,
        `--copilot-packaged=${app.isPackaged ? "1" : "0"}`,
      ],
    },
  });

  applyShareProtection(getSettings().look.shareVisible);
  attachHudOverlay(win);

  placeOnDisplay(0);
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("hud:collapsed", collapsed);
    if (!hidden) showHudInactive();
  });
  win.on("will-move", syncHudGeometry);
  win.on("moved", syncHudGeometry);
  win.on("will-resize", syncHudGeometry);
  win.on("resized", syncHudGeometry);
  win.on("closed", () => {
    win = null;
    if (!quitting) {
      quitting = true;
      app.quit();
    }
  });
  syncHudGeometry();
}

function applyShareProtection(visible: boolean) {
  try {
    win?.setContentProtection(!visible);
  } catch {
    /* Linux compositors often ignore content protection */
  }
  noteHudMotion();
}

function syncHudGeometry() {
  noteHudMotion();
  if (!win) {
    setHudOcclusion(null, null);
    return;
  }
  const bounds = win.getBounds();
  setHudOcclusion(bounds, screen.getPrimaryDisplay().bounds);
}

function showHud() {
  hidden = false;
  if (!win) {
    createWindow();
    return { ok: true };
  }
  showHudInactive();
  syncHudGeometry();
  return { ok: true };
}

function toggleHud() {
  if (!win) return;
  hidden = !hidden;
  if (hidden) {
    win.hide();
    setHudOcclusion(null, null);
    noteHudMotion();
  } else {
    showHud();
  }
}

function broadcast(channel: string, payload?: unknown) {
  win?.webContents.send(channel, payload);
  if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send(channel, payload);
}

function windowPrefs() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    additionalArguments: [
      `--copilot-api=${WS}`,
      `--copilot-http=${HTTP}`,
      `--copilot-packaged=${app.isPackaged ? "1" : "0"}`,
    ],
  };
}

let lastHomeHash = "#general";

function homeHash(raw?: string) {
  const dest = String(raw || "#general").startsWith("#") ? String(raw || "#general") : `#${raw}`;
  return dest === "#" ? "#general" : dest;
}

function isHomeOpen() {
  return Boolean(homeWin && !homeWin.isDestroyed() && homeWin.isVisible());
}

function closeHome() {
  if (homeWin && !homeWin.isDestroyed()) homeWin.hide();
  return { ok: true, open: false as const };
}

function showHome(dest: string) {
  lastHomeHash = dest;
  win?.webContents.send("hud:close-pops");
  if (homeWin && !homeWin.isDestroyed()) {
    homeWin.show();
    homeWin.focus();
    void homeWin.webContents.executeJavaScript(
      `location.hash = ${JSON.stringify(dest.slice(1) || "general")}`,
    );
    return { ok: true, open: true as const };
  }
  homeWin = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 460,
    minHeight: 520,
    title: "Bana Copilot",
    backgroundColor: "#141418",
    ...chromeWindowExtras(process.platform),
    webPreferences: windowPrefs(),
  });
  homeWin.loadFile(path.join(__dirname, "home.html"), { hash: dest.slice(1) });
  homeWin.on("closed", () => {
    homeWin = null;
  });
  homeWin.webContents.on("did-navigate-in-page", (_e, url) => {
    try {
      const hash = new URL(url).hash;
      if (hash) lastHomeHash = hash.startsWith("#") ? hash : `#${hash}`;
    } catch {
      /* ignore */
    }
  });
  return { ok: true, open: true as const };
}

function toggleHome(hash = "#general") {
  const dest = homeHash(hash);
  if (isHomeOpen() && (lastHomeHash === dest || dest === "#general")) return closeHome();
  return showHome(dest);
}

function openOnboard() {
  if (onboardWin && !onboardWin.isDestroyed()) {
    onboardWin.show();
    onboardWin.focus();
    return { ok: true };
  }
  onboardWin = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 420,
    minHeight: 520,
    title: "Bana Copilot",
    backgroundColor: "#121214",
    ...chromeWindowExtras(process.platform),
    webPreferences: windowPrefs(),
  });
  onboardWin.loadFile(path.join(__dirname, "onboard.html"));
  onboardWin.on("closed", () => {
    onboardWin = null;
    if (!quitting) showHud();
  });
  return { ok: true };
}

function installAppMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : [
            {
              label: "File",
              submenu: [{ role: "quit" as const }],
            },
          ]),
      { role: "editMenu" as const },
    ]),
  );
}

function setCollapsed(next: boolean) {
  collapsed = next;
  if (!collapsed) menuOpen = false;
  resizeHud();
  win?.webContents.send("hud:collapsed", collapsed);
}

function setMenuOpen(next: boolean) {
  menuOpen = Boolean(next);
  resizeHud();
  return { open: menuOpen };
}

function mediaStatus(kind: "microphone" | "screen") {
  try {
    if (!canQueryMediaAccess(process.platform, kind)) return "unknown";
    return systemPreferences.getMediaAccessStatus(kind);
  } catch {
    return "unknown";
  }
}

function micStatus() {
  return mediaStatus("microphone");
}

function screenStatus() {
  return mediaStatus("screen");
}

/**
 * Lets getDisplayMedia in the renderer take system (loopback) audio —
 * Zoom / Meet / Teams output — instead of the laptop microphone.
 * Video is required by the picker API; the renderer drops those tracks.
 */
function installLoopbackCapture() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === "media" ||
        permission === "display-capture" ||
        permission === "clipboard-sanitized-write",
    );
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 2, height: 2 },
      });
      const source = sources[0];
      if (!source) {
        callback({});
        return;
      }
      const audio = request.audioRequested ? loopbackAudio(process.platform) : undefined;
      callback(audio ? { video: source, audio } : { video: source });
    } catch (err) {
      console.error("[loopback]", err);
      callback({});
    }
  });
}

async function openPrefs(kind: "mic" | "screen") {
  for (const url of preferenceUrls(process.platform, kind)) {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      /* try next */
    }
  }
  return { ok: false };
}

ipcMain.handle("permissions:info", () => ({
  status: micStatus(),
  mic: micStatus(),
  screen: screenStatus(),
  listName: listName(),
  execPath: process.execPath,
  displays: screen.getAllDisplays().map((d, i) => ({
    index: i,
    primary: d.id === screen.getPrimaryDisplay().id,
    bounds: d.bounds,
  })),
}));

ipcMain.handle("permissions:mic", async () => {
  if (process.platform === "darwin" && micStatus() !== "granted") {
    await systemPreferences.askForMediaAccess("microphone");
  }
  return { status: micStatus(), listName: listName() };
});

ipcMain.handle("permissions:screen", async () => {
  if (STREAM_CAPTURE) {
    return { status: "unknown", ok: true, sources: 1, hasPixels: false, stream: true, listName: listName() };
  }
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 64, height: 36 },
    });
    const thumb = sources[0]?.thumbnail;
    const hasPixels = Boolean(thumb && !thumb.isEmpty() && thumb.getSize().width > 2);
    const status = screenStatus();
    return {
      status,
      ok: status === "granted" || hasPixels,
      sources: sources.length,
      hasPixels,
      listName: listName(),
    };
  } catch (err) {
    return {
      status: screenStatus(),
      ok: false,
      sources: 0,
      hasPixels: false,
      error: err instanceof Error ? err.message : String(err),
      listName: listName(),
    };
  }
});

ipcMain.handle("permissions:open-mic-settings", () => openPrefs("mic"));
ipcMain.handle("permissions:open-screen-settings", () => openPrefs("screen"));

ipcMain.handle("capture:list", async () => {
  try {
    return { ok: true, sources: await listScreenSources(), listName: listName() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      listName: listName(),
    };
  }
});

ipcMain.handle("capture:start", async () => {
  if (STREAM_CAPTURE) return { ok: true, stream: true, listName: listName() };
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 2, height: 2 },
    });
    syncHudGeometry();
    startScreenWatch((event) => {
      win?.webContents.send("capture:frame", event);
    });
    return { ok: true, listName: listName() };
  } catch (err) {
    await openPrefs("screen");
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      listName: listName(),
    };
  }
});

ipcMain.handle("capture:stop", () => {
  stopScreenWatch();
  return { ok: true };
});

ipcMain.handle("capture:shot", async () => {
  try {
    noteHudMotion();
    const shot = await grabScreenshot();
    if (!shot) return { ok: false, error: "No display to capture" };
    return { ok: true, ...shot };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle("meeting:detect", async () => detectMeetingApp());

ipcMain.handle("hud:cycle-display", () => {
  placeOnDisplay(displayIndex + 1);
  const displays = screen.getAllDisplays();
  return {
    index: displayIndex,
    count: displays.length,
    primary: displays[displayIndex]?.id === screen.getPrimaryDisplay().id,
  };
});

ipcMain.handle("hud:set-collapsed", (_e, next: boolean) => {
  setCollapsed(Boolean(next));
  return { collapsed };
});

ipcMain.handle("hud:set-menu", (_e, next: boolean) => setMenuOpen(Boolean(next)));

ipcMain.handle("hud:hide", () => {
  if (win && !hidden) {
    hidden = true;
    win.hide();
    setHudOcclusion(null, null);
    noteHudMotion();
  }
  return { ok: true };
});

ipcMain.handle("hud:show", () => showHud());

ipcMain.handle("hud:set-focusable", (_e, next: boolean) => {
  setHudKeyboard(Boolean(next));
  return { ok: true };
});

ipcMain.handle("hud:toggle-interact", () => toggleHudInteract());

ipcMain.handle("home:open", (_e, hash?: string) => toggleHome(hash || "#general"));
ipcMain.handle("home:close", () => closeHome());

ipcMain.handle("onboard:status", () => ({ done: isOnboarded() }));

ipcMain.handle("onboard:finish", () => {
  markOnboarded();
  if (onboardWin && !onboardWin.isDestroyed()) onboardWin.close();
  showHud();
  return { ok: true };
});

ipcMain.handle("app:quit", () => {
  quitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle("api:get", () => ({ http: HTTP, ws: WS }));

ipcMain.handle("api:set", (_e, raw: string) => {
  try {
    const http = sanitizeApiBase(raw);
    const previous = HTTP;
    fs.writeFileSync(remoteFile(), JSON.stringify({ http }));
    applyRemote();
    const relaunch = previous !== HTTP;
    if (relaunch) {
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 250);
    }
    return { ok: true, http: HTTP, relaunch };
  } catch (err) {
    return { ok: false, http: HTTP, error: err instanceof Error ? err.message : "Invalid API URL." };
  }
});

ipcMain.handle("settings:get", () => ({
  settings: getSettings(),
}));

ipcMain.handle("settings:set", (_e, patch: unknown) => {
  const result = updateSettings((patch ?? {}) as Parameters<typeof updateSettings>[0]);
  applyShareProtection(result.settings.look.shareVisible);
  broadcast("settings:changed", result.settings);
  return result;
});

ipcMain.handle("settings:reset-shortcuts", () => {
  const result = resetShortcuts();
  broadcast("settings:changed", result.settings);
  return result;
});

ipcMain.handle("settings:session-active", (_e, next: boolean) => {
  const result = setSessionActive(next);
  setOverlaySession(Boolean(next), homeWin);
  broadcast("settings:changed", result.settings);
  return result;
});

ipcMain.handle("auth:ensure", async () => {
  const file = path.join(app.getPath("userData"), "device.json");
  let deviceId = randomUUID();
  try {
    if (fs.existsSync(file)) {
      deviceId = JSON.parse(fs.readFileSync(file, "utf8")).deviceId ?? deviceId;
    } else {
      fs.writeFileSync(file, JSON.stringify({ deviceId }));
    }
  } catch {
    fs.writeFileSync(file, JSON.stringify({ deviceId }));
  }
  let lastErr: unknown;
  for (let i = 0; i < 25; i += 1) {
    try {
      const res = await fetch(`${HTTP}/auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (!res.ok) {
        throw new Error(`Auth failed (${res.status}). Is the API running?`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("API is not running on 127.0.0.1:8787");
});

ipcMain.handle("sessions:list", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
});

ipcMain.handle("profile:get", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
});

ipcMain.handle("profile:save", async (_e, token: string, body: unknown) => {
  const res = await fetch(`${HTTP}/profile`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("documents:list", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/documents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
});

ipcMain.handle("documents:save", async (_e, token: string, payload: unknown) => {
  const res = await fetch(`${HTTP}/documents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

async function modesRequest(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const res = await fetch(`${HTTP}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (method !== "GET") broadcast("profile:changed");
  return json;
}

ipcMain.handle("modes:list", async (_e, token: string) => modesRequest(token, "/modes"));
ipcMain.handle("modes:create", async (_e, token: string, body: unknown) =>
  modesRequest(token, "/modes", "POST", body),
);
ipcMain.handle("modes:update", async (_e, token: string, id: string, body: unknown) =>
  modesRequest(token, `/modes/${id}`, "PUT", body),
);
ipcMain.handle("modes:delete", async (_e, token: string, id: string) =>
  modesRequest(token, `/modes/${id}`, "DELETE"),
);
ipcMain.handle("modes:select", async (_e, token: string, id: string) =>
  modesRequest(token, `/modes/${id}/select`, "POST"),
);
ipcMain.handle("modes:add-doc", async (_e, token: string, id: string, body: unknown) =>
  modesRequest(token, `/modes/${id}/documents`, "POST", body),
);
ipcMain.handle("modes:delete-doc", async (_e, token: string, id: string, docId: string) =>
  modesRequest(token, `/modes/${id}/documents/${docId}`, "DELETE"),
);

ipcMain.handle("account:get", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/account`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
});

ipcMain.handle("billing:checkout", async (_e, token: string, planId: string) => {
  const res = await fetch(`${HTTP}/billing/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ planId }),
  });
  return res.json();
});

ipcMain.handle("billing:activate", async (_e, token: string, planId: string) => {
  const res = await fetch(`${HTTP}/billing/activate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ planId }),
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("billing:key", async (_e, token: string, body: unknown) => {
  const res = await fetch(`${HTTP}/billing/key`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("billing:key-clear", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/billing/key`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("billing:open-url", async (_e, url: string) => {
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("stories:list", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/stories`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
});

ipcMain.handle("stories:save", async (_e, token: string, body: unknown) => {
  const res = await fetch(`${HTTP}/stories`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("stories:delete", async (_e, token: string, id: string) => {
  const res = await fetch(`${HTTP}/stories/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("stories:rebuild", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/stories/rebuild`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle("practice:plan", async (_e, token: string) => {
  const res = await fetch(`${HTTP}/practice`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
});

ipcMain.handle("practice:turn", async (_e, token: string, body: unknown) => {
  const res = await fetch(`${HTTP}/practice/turn`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  broadcast("profile:changed");
  return json;
});

ipcMain.handle(
  "resume:save",
  async (
    _e,
    token: string,
    payload: { text?: string; pdfBase64?: string; title?: string },
  ) => {
    const res = await fetch(`${HTTP}/resumes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    broadcast("profile:changed");
    return json;
  },
);

app.whenReady().then(async () => {
  applyRemote();
  installAppMenu();
  installLoopbackCapture();
  loadSettings();
  createWindow();
  attachShortcutHandlers({
    hide: toggleHud,
    collapse: () => setCollapsed(!collapsed),
    home: () => toggleHome("#general"),
    listen: () => win?.webContents.send("listen:toggle"),
    assist: () => win?.webContents.send("assist:trigger"),
    say_next: () => win?.webContents.send("assist:action", "say_next"),
    follow_up: () => win?.webContents.send("assist:action", "follow_up"),
    fact_check: () => win?.webContents.send("assist:action", "fact_check"),
    recap: () => win?.webContents.send("assist:action", "recap"),
    screen: () => win?.webContents.send("assist:screen"),
    share: () => win?.webContents.send("hud:share"),
    clear: () => win?.webContents.send("context:clear"),
    interact: () => toggleHudInteract(),
    move_up: () => nudgeHud(0, -60),
    move_down: () => nudgeHud(0, 60),
    move_left: () => nudgeHud(-60, 0),
    move_right: () => nudgeHud(60, 0),
  });
  const permsGranted =
    process.platform !== "darwin" ||
    (screenStatus() === "granted" && micStatus() === "granted");
  if (!isOnboarded() || !permsGranted) openOnboard();
  else showHud();
});

app.on("activate", () => {
  const permsGranted =
    process.platform !== "darwin" ||
    (screenStatus() === "granted" && micStatus() === "granted");
  if (!isOnboarded() || !permsGranted) {
    openOnboard();
    return;
  }
  showHud();
});

app.on("before-quit", () => {
  quitting = true;
  stopScreenWatch();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (!quitting) quitting = true;
  app.quit();
});
