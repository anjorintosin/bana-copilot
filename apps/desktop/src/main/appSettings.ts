import { app, globalShortcut } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  SHORTCUT_META,
  mergeSettings,
  shortcutConflict,
  type AppSettings,
  type ShortcutId,
} from "../settings";

export type ShortcutHandlers = Record<ShortcutId, () => void>;

let settings: AppSettings = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SETTINGS.shortcuts }, look: { ...DEFAULT_SETTINGS.look } };
let sessionActive = false;
let registered: string[] = [];
let handlers: ShortcutHandlers | null = null;

function filePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings() {
  try {
    if (fs.existsSync(filePath())) {
      settings = mergeSettings(JSON.parse(fs.readFileSync(filePath(), "utf8")));
    } else {
      settings = mergeSettings(DEFAULT_SETTINGS);
      saveSettingsFile();
    }
  } catch {
    settings = mergeSettings(DEFAULT_SETTINGS);
  }
  return getSettings();
}

function saveSettingsFile() {
  fs.writeFileSync(filePath(), JSON.stringify(settings, null, 2));
}

export function getSettings(): AppSettings {
  return {
    shortcuts: { ...settings.shortcuts },
    look: { ...settings.look },
  };
}

export function setSessionActive(next: boolean) {
  sessionActive = Boolean(next);
  return applyShortcuts();
}

export function isSessionActive() {
  return sessionActive;
}

function unregisterOurs() {
  for (const accelerator of registered) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* already gone */
    }
  }
  registered = [];
}

export function applyShortcuts() {
  unregisterOurs();
  const failed: { id: ShortcutId; accelerator: string }[] = [];
  for (const meta of SHORTCUT_META) {
    if (meta.scope === "session" && !sessionActive) continue;
    const accelerator = settings.shortcuts[meta.id];
    const ok = globalShortcut.register(accelerator, () => handlers?.[meta.id]());
    if (ok) registered.push(accelerator);
    else failed.push({ id: meta.id, accelerator });
  }
  return { settings: getSettings(), sessionActive, failed };
}

export function updateSettings(patch: {
  shortcuts?: Partial<AppSettings["shortcuts"]>;
  look?: Partial<AppSettings["look"]>;
}) {
  const next = mergeSettings({
    shortcuts: { ...settings.shortcuts, ...(patch.shortcuts ?? {}) },
    look: { ...settings.look, ...(patch.look ?? {}) },
  });
  if (patch.shortcuts) {
    for (const [id, accelerator] of Object.entries(patch.shortcuts)) {
      const clash = shortcutConflict(next.shortcuts, id as ShortcutId, accelerator);
      if (clash) {
        return {
          ok: false as const,
          error: `That shortcut is already used by ${clash}.`,
          settings: getSettings(),
          sessionActive,
        };
      }
    }
  }
  settings = next;
  saveSettingsFile();
  const applied = applyShortcuts();
  if (applied.failed.length) {
    return {
      ok: false as const,
      error: `Could not bind ${applied.failed.map((item) => item.id).join(", ")}. Another app may own it.`,
      settings: applied.settings,
      sessionActive,
    };
  }
  return { ok: true as const, settings: applied.settings, sessionActive };
}

export function resetShortcuts() {
  return updateSettings({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts } });
}

export function attachShortcutHandlers(next: ShortcutHandlers) {
  handlers = next;
  return applyShortcuts();
}

function onboardFile() {
  return path.join(app.getPath("userData"), "onboard.json");
}

/** Each newly downloaded version starts at onboarding once, so permissions get rechecked. */
export function isOnboarded() {
  try {
    const saved = JSON.parse(fs.readFileSync(onboardFile(), "utf8"));
    if (saved.done !== true || saved.version !== app.getVersion()) return false;
    if (saved.appPath && saved.appPath !== app.getAppPath()) return false;
    return true;
  } catch {
    return false;
  }
}

export function markOnboarded() {
  fs.writeFileSync(
    onboardFile(),
    JSON.stringify({ done: true, version: app.getVersion(), appPath: app.getAppPath() }),
  );
}
