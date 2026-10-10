export const SHORTCUT_IDS = [
  "hide",
  "collapse",
  "home",
  "listen",
  "assist",
  "say_next",
  "follow_up",
  "fact_check",
  "recap",
  "screen",
  "share",
  "clear",
  "interact",
  "move_up",
  "move_down",
  "move_left",
  "move_right",
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
  { id: "home", label: "Open settings", hint: "Works anytime", scope: "always" },
  { id: "listen", label: "Start / end session", hint: "Only during a session", scope: "session" },
  { id: "assist", label: "Ask / assist", hint: "Works anytime", scope: "always" },
  { id: "say_next", label: "What should I say", hint: "Only during a session", scope: "session" },
  { id: "follow_up", label: "Follow-ups", hint: "Only during a session", scope: "session" },
  { id: "fact_check", label: "Fact check", hint: "Only during a session", scope: "session" },
  { id: "recap", label: "Recap", hint: "Only during a session", scope: "session" },
  { id: "screen", label: "Solve screen", hint: "Works anytime", scope: "always" },
  { id: "share", label: "Screen share HUD", hint: "Show or hide the HUD on Zoom/Meet share", scope: "always" },
  { id: "clear", label: "Clear context", hint: "Only during a session", scope: "session" },
  { id: "interact",
    label: "Unlock HUD clicks",
    hint: "Unused — the HUD is always clickable",
    scope: "session",
  },
  { id: "move_up", label: "Move HUD Up", hint: "Nudge HUD position up", scope: "always" },
  { id: "move_down", label: "Move HUD Down", hint: "Nudge HUD position down", scope: "always" },
  { id: "move_left", label: "Move HUD Left", hint: "Nudge HUD position left", scope: "always" },
  { id: "move_right", label: "Move HUD Right", hint: "Nudge HUD position right", scope: "always" },
];

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  hide: "CommandOrControl+\\",
  collapse: "CommandOrControl+Shift+\\",
  home: "CommandOrControl+Shift+H",
  listen: "CommandOrControl+Shift+L",
  assist: "CommandOrControl+Enter",
  say_next: "CommandOrControl+1",
  follow_up: "CommandOrControl+2",
  fact_check: "CommandOrControl+3",
  recap: "CommandOrControl+4",
  screen: "CommandOrControl+5",
  share: "CommandOrControl+Shift+S",
  clear: "CommandOrControl+Shift+Backspace",
  interact: "CommandOrControl+Shift+A",
  move_up: "CommandOrControl+Up",
  move_down: "CommandOrControl+Down",
  move_left: "CommandOrControl+Left",
  move_right: "CommandOrControl+Right",
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
      if (part === "Up") return mac ? "↑" : "Up";
      if (part === "Down") return mac ? "↓" : "Down";
      if (part === "Left") return mac ? "←" : "Left";
      if (part === "Right") return mac ? "→" : "Right";
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
    if (shortcuts.screen === "CommandOrControl+Shift+Enter") {
      shortcuts.screen = DEFAULT_SHORTCUTS.screen;
    }
    if (shortcuts.move_up === "CommandOrControl+Alt+Up") {
      shortcuts.move_up = DEFAULT_SHORTCUTS.move_up;
    }
    if (shortcuts.move_down === "CommandOrControl+Alt+Down") {
      shortcuts.move_down = DEFAULT_SHORTCUTS.move_down;
    }
    if (shortcuts.move_left === "CommandOrControl+Alt+Left") {
      shortcuts.move_left = DEFAULT_SHORTCUTS.move_left;
    }
    if (shortcuts.move_right === "CommandOrControl+Alt+Right") {
      shortcuts.move_right = DEFAULT_SHORTCUTS.move_right;
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
