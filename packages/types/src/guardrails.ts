/**
 * Ingress guardrails (OWASP Input Validation, Unicode TR39 / UAX #15,
 * Trojan Source, OWASP LLM01). Canonicalize first, then accept.
 */

export const LIMITS = {
  title: 120,
  line: 160,
  requirements: 8_000,
  document: 80_000,
  storyName: 80,
  storyField: 2_000,
  question: 2_000,
  transcript: 8_000,
  appName: 80,
  deviceId: 80,
  apiKey: 512,
  url: 200,
  priorTurns: 8,
  imageChars: 2_800_000,
  modeName: 48,
  modeInstructions: 4_000,
} as const;

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** Controls, zero-width, BiDi overrides, and Unicode tags. Keep ZWJ / ZWNJ. */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B\u202A-\u202E\u2060\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0001}\u{E0020}-\u{E007F}]/gu;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_RE = /^[a-zA-Z0-9._-]{8,80}$/;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const KEY_PREFIX = /^(sk-|sk-ant-|gsk_|xai-)/;

export function sanitizeText(
  raw: unknown,
  opts: { max?: number; multiline?: boolean } = {},
): string {
  if (typeof raw !== "string") return "";
  let text = raw.normalize("NFC");
  text = text.replace(/\u2028|\u2029/g, "\n");
  text = text.replace(INVISIBLE, "");
  text = text.replace(/\r\n?/g, "\n");
  if (opts.multiline === false) {
    text = text.replace(/\s+/g, " ");
  } else {
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  }
  text = text.trim();
  const max = opts.max ?? LIMITS.document;
  if (text.length > max) text = text.slice(0, max).trim();
  return text;
}

export function sanitizeLine(raw: unknown, max?: number): string {
  return sanitizeText(raw, { max: max ?? LIMITS.line, multiline: false });
}

export function sanitizeSecret(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let key = raw.normalize("NFC").replace(/\s+/g, "").replace(INVISIBLE, "");
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  if (!key) return "";
  if (key.length < 8 || key.length > LIMITS.apiKey) {
    throw new GuardError("That key is the wrong length.");
  }
  if (!PRINTABLE_ASCII.test(key)) {
    throw new GuardError("Model keys can only contain visible ASCII characters.");
  }
  if (key.includes("\n") || key.includes("\r")) {
    throw new GuardError("That key is not valid.");
  }
  if (!KEY_PREFIX.test(key) && key.length < 20) {
    throw new GuardError("Paste a full model API key.");
  }
  return key;
}

export function sanitizeHttpUrl(raw: unknown): string {
  const value = sanitizeLine(raw, LIMITS.url);
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GuardError("That URL is not valid.");
  }
  const local =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new GuardError("Use an https URL.");
  }
  if (parsed.username || parsed.password) {
    throw new GuardError("Do not put credentials in the URL.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function sanitizeDeviceId(raw: unknown): string {
  const id = sanitizeLine(raw, LIMITS.deviceId).replace(/\s+/g, "");
  if (!DEVICE_RE.test(id)) {
    throw new GuardError("Device id is not valid.");
  }
  return id;
}

export function sanitizeUuid(raw: unknown, label = "id"): string {
  const id = sanitizeLine(raw, 36);
  if (!UUID_RE.test(id)) throw new GuardError(`That ${label} is not valid.`);
  return id.toLowerCase();
}

export function optionalUuid(raw: unknown, label = "id"): string | undefined {
  if (raw == null || raw === "") return undefined;
  return sanitizeUuid(raw, label);
}

export function allowlist<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = sanitizeLine(raw, 40);
  if (allowed.includes(value as T)) return value as T;
  if (fallback !== undefined) return fallback;
  throw new GuardError("That option is not allowed.");
}

export function sanitizeJobContext(job?: {
  title?: string | null;
  company?: string | null;
  requirements?: string | null;
}) {
  return {
    title: sanitizeLine(job?.title ?? "", LIMITS.line) || null,
    company: sanitizeLine(job?.company ?? "", LIMITS.line) || null,
    requirements: sanitizeText(job?.requirements ?? "", {
      max: LIMITS.requirements,
    }) || null,
  };
}
