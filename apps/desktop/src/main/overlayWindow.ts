import { app, BrowserWindow, ipcMain } from "electron";

/**
 * Keep the HUD from becoming the foreground app.
 *
 * Interview sites flag window.blur / visibilitychange when Electron
 * activates. A normal BrowserWindow always does that on click.
 *
 * macOS: Electron `type: "panel"` is not a real NSPanel, and
 * `-webkit-app-region: drag` is a hidden titlebar that activates the app.
 * Accessory policy + never focusing + no native drag is the supported path.
 *
 * Windows: `focusable: false` sets WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW
 * (skipTaskbar). hookWindowMessage cannot return MA_NOACTIVATE.
 *
 * Linux: skip taskbar / pager and refuse focus. Click-through uses
 * setIgnoreMouseEvents where the compositor allows it.
 *
 * Mouse-leave proctors still see the cursor enter any hit-tested overlay.
 * During a session the HUD is click-through so the browser keeps both
 * focus and hover. Unlock with the interact shortcut to click the HUD.
 */

let hud: BrowserWindow | null = null;
let allowKeyboard = false;
let clickThrough = false;
let sessionStealth = false;

export function hudWindowOptions() {
  return {
    frame: false,
    transparent: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    closable: false,
    resizable: false,
    movable: true,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    ...(process.platform === "darwin"
      ? { type: "panel" as const, titleBarStyle: "hidden" as const }
      : {}),
  };
}

export function attachHudOverlay(win: BrowserWindow) {
  hud = win;
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  pinHud(win);

  win.on("focus", () => {
    if (allowKeyboard) return;
    if (sessionStealth && !clickThrough) return;
    refuseFocus(win);
  });

  ipcMain.on("hud:move-by", (_e, dx: number, dy: number) => {
    if (!hud || typeof dx !== "number" || typeof dy !== "number") return;
    const [x, y] = hud.getPosition();
    hud.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
}

function pinHud(win: BrowserWindow) {
  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false);
    win.setHiddenInMissionControl(true);
    win.setAlwaysOnTop(true, "screen-saver", 1);
    return;
  }
  if (process.platform === "win32") {
    win.setAlwaysOnTop(true, "screen-saver", 1);
    win.setSkipTaskbar(true);
    return;
  }
  win.setAlwaysOnTop(true);
  win.setSkipTaskbar(true);
}

function refuseFocus(win: BrowserWindow) {
  allowKeyboard = false;
  win.setFocusable(false);
}

export function showHudInactive() {
  if (!hud) return;
  allowKeyboard = false;
  hud.setFocusable(false);
  pinHud(hud);
  hud.showInactive();
}

export function setHudKeyboard(on: boolean) {
  if (!hud) return;
  if (sessionStealth && on) return;
  allowKeyboard = on;
  hud.setFocusable(on);
  if (on) {
    hud.showInactive();
    hud.focus();
    return;
  }
  refuseFocus(hud);
}

export function setHudClickThrough(on: boolean) {
  clickThrough = on;
  hud?.setIgnoreMouseEvents(on, { forward: true });
  hud?.webContents.send("hud:pass-through", on);
}

export function isOverlaySession() {
  return sessionStealth;
}

export function setOverlaySession(active: boolean, homeWin?: BrowserWindow | null) {
  sessionStealth = active;
  allowKeyboard = false;
  if (!hud) return;

  hud.setFocusable(false);
  pinHud(hud);

  if (active) {
    setHudClickThrough(false);
    if (homeWin && !homeWin.isDestroyed()) homeWin.hide();
    if (process.platform === "darwin") {
      app.dock?.hide();
      app.setActivationPolicy("accessory");
    }
    return;
  }

  setHudClickThrough(false);
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    app.dock?.show();
  }
}

export function toggleHudInteract() {
  if (!sessionStealth) {
    setHudClickThrough(false);
    return { clickThrough: false, session: false };
  }
  setHudClickThrough(!clickThrough);
  return { clickThrough, session: true };
}
