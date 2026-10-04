import {
  GuardError,
  LIMITS,
  allowlist,
  optionalUuid,
  sanitizeHttpUrl,
  sanitizeJobContext,
  sanitizeLine,
  sanitizeText,
  sanitizeUuid,
  type ClientEvent,
  type InterviewStageId,
  type InterviewTrackId,
} from "@meeting-copilot/types";

const TRACKS = [
  "auto",
  "software",
  "data",
  "product",
  "design",
  "consulting",
  "finance",
  "sales",
  "marketing",
  "general",
] as const;

const STAGES = [
  "auto",
  "intro",
  "behavioral",
  "technical",
  "coding",
  "system_design",
  "case",
  "wrap",
] as const;

const ASSISTS = [
  "assist",
  "ask",
  "screen",
  "say_next",
  "follow_up",
  "fact_check",
  "recap",
] as const;

const buckets = new Map<string, { n: number; reset: number }>();

export function takeWriteToken(key: string, limit = 40, windowMs = 60_000) {
  const now = Date.now();
  const hit = buckets.get(key);
  if (!hit || now > hit.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  if (hit.n >= limit) return false;
  hit.n += 1;
  return true;
}

export function sanitizeTrack(raw: unknown): InterviewTrackId {
  return allowlist(raw, TRACKS, "auto");
}

export function sanitizeStage(raw: unknown): InterviewStageId | undefined {
  if (raw == null || raw === "") return undefined;
  return allowlist(raw, STAGES, "auto");
}

export function sanitizeClientEvent(event: ClientEvent): ClientEvent {
  if ("sessionId" in event && event.sessionId) {
    event = { ...event, sessionId: sanitizeUuid(event.sessionId, "session") };
  }
  if (event.type === "meeting.started") {
    return {
      ...event,
      jobContext: event.jobContext
        ? {
            title: sanitizeJobContext(event.jobContext).title ?? undefined,
            company: sanitizeJobContext(event.jobContext).company ?? undefined,
            requirements: sanitizeJobContext(event.jobContext).requirements ?? undefined,
          }
        : undefined,
      track: event.track ? sanitizeTrack(event.track) : undefined,
      stage: sanitizeStage(event.stage),
    };
  }
  if (event.type === "session.config") {
    return {
      ...event,
      track: event.track ? sanitizeTrack(event.track) : undefined,
      stage: sanitizeStage(event.stage),
    };
  }
  if (event.type === "listen.start") {
    return {
      ...event,
      source: allowlist(event.source, ["system", "mic"] as const),
      track: event.track ? sanitizeTrack(event.track) : undefined,
      stage: sanitizeStage(event.stage),
    };
  }
  if (event.type === "meeting.app") {
    return { ...event, app: sanitizeLine(event.app, LIMITS.appName) };
  }
  if (event.type === "assist.request") {
    const action = allowlist(event.action, ASSISTS);
    const image =
      typeof event.imageBase64 === "string" && event.imageBase64.length > LIMITS.imageChars
        ? undefined
        : event.imageBase64;
    return {
      ...event,
      action,
      text: event.text
        ? sanitizeText(event.text, { max: LIMITS.question })
        : undefined,
      imageBase64: image,
      mimeType: sanitizeLine(event.mimeType ?? "", 80) || undefined,
    };
  }
  if (event.type === "transcript.partial" || event.type === "transcript.final") {
    return {
      ...event,
      text: sanitizeText(event.text, { max: LIMITS.transcript }),
    };
  }
  return event;
}

export { GuardError, LIMITS, optionalUuid, sanitizeHttpUrl, sanitizeLine, sanitizeText };
