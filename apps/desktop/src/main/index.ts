import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
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
  loadSettings,
  resetShortcuts,
  setSessionActive,
  updateSettings,
} from "./appSettings";
import {
  attachHudOverlay,
  hudWindowOptions,
  isOverlaySession,
  setHudKeyboard,
  setOverlaySession,
  showHudInactive,
  toggleHudInteract,
} from "./overlayWindow";
import { PRODUCTION_HTTP, PRODUCTION_WS } from "../remote";

app.setName("Bana Copilot");

let win: BrowserWindow | null = null;
let homeWin: BrowserWindow | null = null;
let hidden = true;
let collapsed = false;
let displayIndex = 0;

const COLLAPSED = { width: 640, height: 72 };
const EXPANDED = { width: 640, height: 560 };
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
  if (app.isPackaged && PRODUCTION_HTTP) {
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

function placeOnDisplay(index: number, size = collapsed ? COLLAPSED : EXPANDED) {
  if (!win) return;
  const displays = screen.getAllDisplays();
  displayIndex = ((index % displays.length) + displays.length) % displays.length;
  const display = displays[displayIndex];
  const x = display.workArea.x + display.workArea.width - size.width - 24;
  const y = display.workArea.y + 48;
  win.setBounds({ x, y, width: size.width, height: size.height });
  syncHudGeometry();
}

function createWindow() {
  win = new BrowserWindow({
    ...EXPANDED,
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
  syncHudGeometry();
}

function applyShareProtection(visible: boolean) {
  win?.setContentProtection(!visible);
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

function openHome(hash = "#overview") {
  if (isOverlaySession()) {
    win?.webContents.send(
      "hud:toast",
      "End the session before opening Home — that window would take focus.",
    );
    return { ok: false };
  }
  const dest = hash.startsWith("#") ? hash : `#${hash}`;
  if (homeWin && !homeWin.isDestroyed()) {
    homeWin.show();
    homeWin.focus();
    void homeWin.webContents.executeJavaScript(
      `location.hash = ${JSON.stringify(dest)}`,
    );
    return { ok: true };
  }
  homeWin = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    title: "Bana Copilot",
    backgroundColor: "#0c0c10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
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
  homeWin.loadFile(path.join(__dirname, "home.html"), { hash: dest.slice(1) });
  homeWin.on("closed", () => {
    homeWin = null;
    if (!win || hidden || !win.isVisible()) app.quit();
  });
  return { ok: true };
}

function setCollapsed(next: boolean) {
  collapsed = next;
  placeOnDisplay(displayIndex);
  syncHudGeometry();
  win?.webContents.send("hud:collapsed", collapsed);
}

function micStatus() {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("microphone");
}

/**
 * Lets getDisplayMedia in the renderer take system (loopback) audio —
 * Zoom / Meet / Teams output — instead of the laptop microphone.
 * Video is required by the picker API; the renderer drops those tracks.
 */
function installLoopbackCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
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
      callback({ video: source, audio: "loopback" });
    } catch (err) {
      console.error("[loopback]", err);
      callback({});
    }
  });
}

async function openPrefs(kind: "mic" | "screen") {
  const mic = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
  ];
  const capture = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
  ];
  for (const url of kind === "mic" ? mic : capture) {
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

ipcMain.handle("home:open", (_e, hash?: string) => openHome(hash || "#overview"));

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
  installLoopbackCapture();
  loadSettings();
  openHome("#overview");
  attachShortcutHandlers({
    hide: toggleHud,
    collapse: () => setCollapsed(!collapsed),
    home: () => openHome("#overview"),
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
  });

  if (process.platform === "darwin" && micStatus() !== "granted") {
    await systemPreferences.askForMediaAccess("microphone");
  }
});

app.on("activate", () => {
  if (isOverlaySession()) return;
  if (!homeWin) openHome("#overview");
});

app.on("will-quit", () => {
  stopScreenWatch();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
