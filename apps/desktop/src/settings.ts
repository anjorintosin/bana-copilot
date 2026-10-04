export const SHORTCUT_IDS = [
  "hide",
  "collapse",
  "home",
  "listen",
  "assist",
  "screen",
  "clear",
  "interact",
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];
export type ShortcutScope = "always" | "session";

export type ShortcutMeta = {
  id: ShortcutId;
  label: string;
  hint: string;
  scope: ShortcutScope;
};

export const SHORTCUT_META: ShortcutMeta[] = [
  { id: "hide", label: "Show or hide HUD", hint: "Works anytime", scope: "always" },
  { id: "collapse", label: "Collapse HUD", hint: "Works anytime", scope: "always" },
  { id: "home", label: "Open dashboard", hint: "Works anytime", scope: "always" },
  { id: "listen", label: "Start / capture listen", hint: "Only during a session", scope: "session" },
  { id: "assist", label: "Ask / assist", hint: "Only during a session", scope: "session" },
  { id: "screen", label: "Solve screen", hint: "Only during a session", scope: "session" },
  { id: "clear", label: "Clear context", hint: "Only during a session", scope: "session" },
  {
    id: "interact",
    label: "Unlock HUD clicks",
    hint: "Session only — clicks pass through until you toggle this",
    scope: "session",
  },
];

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  hide: "CommandOrControl+\\",
  collapse: "CommandOrControl+Shift+\\",
  home: "CommandOrControl+Shift+H",
  listen: "CommandOrControl+Shift+L",
  assist: "CommandOrControl+Enter",
  screen: "CommandOrControl+Shift+Enter",
  clear: "CommandOrControl+Shift+Backspace",
  interact: "CommandOrControl+Shift+A",
};

export type LookSettings = {
  opacity: number;
  solidOnHover: boolean;
  /** When false (default), Zoom/Meet cannot see the HUD. */
  shareVisible: boolean;
};

export type AppSettings = {
  shortcuts: Record<ShortcutId, string>;
  look: LookSettings;
};

export const DEFAULT_LOOK: LookSettings = {
  opacity: 55,
  solidOnHover: true,
  shareVisible: false,
};

export const DEFAULT_SETTINGS: AppSettings = {
  shortcuts: { ...DEFAULT_SHORTCUTS },
  look: { ...DEFAULT_LOOK },
};

const NAMED_KEYS: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Escape: "Escape",
  Tab: "Tab",
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  "\\": "\\",
  "/": "/",
  ",": ",",
  ".": ".",
  "-": "-",
  "=": "=",
  "[": "[",
  "]": "]",
  ";": ";",
  "'": "'",
  "`": "`",
};

export function eventToAccelerator(event: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift", "Dead"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  let key = NAMED_KEYS[event.key];
  if (!key && /^F\d{1,2}$/.test(event.key)) key = event.key;
  if (!key && event.key.length === 1 && /^[a-zA-Z0-9]$/.test(event.key)) {
    key = event.key.toUpperCase();
  }
  if (!key && event.code.startsWith("Key") && event.code.length === 4) {
    key = event.code.slice(3);
  }
  if (!key && event.code.startsWith("Digit") && event.code.length === 6) {
    key = event.code.slice(5);
  }
  if (!key) return null;
  parts.push(key);
  if (parts.length < 2) return null;
  return parts.join("+");
}

export function formatAccelerator(accelerator: string, platform = "darwin") {
  const mac = platform === "darwin";
  return accelerator
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl") return mac ? "⌘" : "Ctrl";
      if (part === "Command") return "⌘";
      if (part === "Control") return mac ? "⌃" : "Ctrl";
      if (part === "Alt") return mac ? "⌥" : "Alt";
      if (part === "Shift") return mac ? "⇧" : "Shift";
      if (part === "Backspace") return mac ? "⌫" : "Backspace";
      if (part === "Enter") return mac ? "↩" : "Enter";
      if (part === "Escape") return "Esc";
      if (part === "Space") return "Space";
      return part;
    })
    .join(mac ? "" : "+");
}

export function isShortcutId(value: string): value is ShortcutId {
  return SHORTCUT_IDS.includes(value as ShortcutId);
}

export function mergeSettings(raw: unknown): AppSettings {
  const input = raw && typeof raw === "object" ? (raw as Partial<AppSettings>) : {};
  const shortcuts = { ...DEFAULT_SHORTCUTS };
  if (input.shortcuts && typeof input.shortcuts === "object") {
    for (const id of SHORTCUT_IDS) {
      const value = input.shortcuts[id];
      if (typeof value === "string" && value.includes("+")) shortcuts[id] = value;
    }
  }
  const look = { ...DEFAULT_LOOK };
  if (input.look && typeof input.look === "object") {
    if (typeof input.look.opacity === "number") {
      look.opacity = Math.min(92, Math.max(28, Math.round(input.look.opacity)));
    }
    if (typeof input.look.solidOnHover === "boolean") {
      look.solidOnHover = input.look.solidOnHover;
    }
    if (typeof input.look.shareVisible === "boolean") {
      look.shareVisible = input.look.shareVisible;
    }
  }
  return { shortcuts, look };
}

export function shortcutConflict(
  shortcuts: Record<ShortcutId, string>,
  id: ShortcutId,
  accelerator: string,
): ShortcutId | null {
  for (const other of SHORTCUT_IDS) {
    if (other !== id && shortcuts[other] === accelerator) return other;
  }
  return null;
}
