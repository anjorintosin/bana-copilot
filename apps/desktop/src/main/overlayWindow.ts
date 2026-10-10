import { BrowserWindow, ipcMain, screen } from "electron";
import { clampHud, overlayWindowExtras } from "../compat";

/**
 * Overlay HUD that stays on top without eating clicks or blocking Quit.
 *
 * Sprint 1: the bar is always hit-testable. We do not setIgnoreMouseEvents
 * on it, and we do not bounce focus away on click (that broke Home on
 * newer macOS). We also skip accessory/dock-hide so Cmd+Q and Dock Quit
 * keep working.
 *
 * Share stealth is content-protection + skipTaskbar + hiddenInMissionControl,
 * not click-through.
 */

let hud: BrowserWindow | null = null;
let allowKeyboard = false;
let sessionStealth = false;

export function hudWindowOptions(platform = process.platform) {
  return {
    frame: false,
    transparent: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    closable: true,
    resizable: false,
    movable: true,
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    ...overlayWindowExtras(platform),
  };
}

export function attachHudOverlay(win: BrowserWindow) {
  hud = win;
  try {
    if (process.platform === "darwin") {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      win.setVisibleOnAllWorkspaces(true);
    }
  } catch {
    /* some Linux WMs reject workspace pinning */
  }
  try {
    win.setMenuBarVisibility(false);
  } catch {
    /* no menu bar */
  }
  pinHud(win);
  win.setIgnoreMouseEvents(false);

  ipcMain.on("hud:move-by", (_e, dx: number, dy: number) => {
    nudgeHud(dx, dy);
  });
}

export function nudgeHud(dx: number, dy: number) {
  if (!hud || typeof dx !== "number" || typeof dy !== "number") return;
  try {
    const bounds = hud.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const pos = clampHud(
      bounds.x + dx,
      bounds.y + dy,
      bounds,
      display.workArea,
    );
    hud.setPosition(pos.x, pos.y);
  } catch {
    /* display query can fail during sleep / display change */
  }
}

function pinHud(win: BrowserWindow) {
  try {
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
  } catch {
    try {
      win.setAlwaysOnTop(true);
    } catch {
      /* compositor refused always-on-top */
    }
  }
}

export function showHudInactive() {
  if (!hud) return;
  hud.setFocusable(true);
  pinHud(hud);
  hud.setIgnoreMouseEvents(false);
  hud.showInactive();
}

export function setHudKeyboard(on: boolean) {
  if (!hud) return;
  allowKeyboard = on;
  hud.setFocusable(true);
  hud.setIgnoreMouseEvents(false);
  if (on) {
    hud.showInactive();
    hud.focus();
  }
}

export function setHudClickThrough(_on: boolean) {
  hud?.setIgnoreMouseEvents(false);
  hud?.webContents.send("hud:pass-through", false);
}

export function isOverlaySession() {
  return sessionStealth;
}

export function setOverlaySession(active: boolean, homeWin?: BrowserWindow | null) {
  sessionStealth = active;
  allowKeyboard = false;
  if (!hud) return;

  hud.setFocusable(true);
  pinHud(hud);
  setHudClickThrough(false);

  if (active) {
    if (homeWin && !homeWin.isDestroyed()) homeWin.hide();
    return;
  }
}

export function toggleHudInteract() {
  setHudClickThrough(false);
  return { clickThrough: false, session: sessionStealth };
}
