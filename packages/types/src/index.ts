export type JobContext = {
  title?: string;
  company?: string;
  requirements?: string;
};

export type DocumentKind = "resume" | "job" | "company" | "notes";

export const GENERAL_MODE_SLUG = "general";
export const GENERAL_MODE_INSTRUCTIONS =
  "Answer with general knowledge. Use attached knowledge files when they fit. Do not invent employers, tools, or facts that are not in those files.";

export type ModeDocument = {
  id: string;
  title: string;
  excerpt: string;
  chars: number;
  createdAt: string;
};

export type AnswerMode = {
  id: string;
  slug: string;
  name: string;
  instructions: string;
  builtin: boolean;
  documentCount: number;
  documents?: ModeDocument[];
};

export type AnswerModeList = {
  modes: AnswerMode[];
  activeModeId: string;
};

export const DOCUMENT_KINDS: { id: DocumentKind; label: string; hint: string }[] = [
  { id: "resume", label: "Resume", hint: "Your experience — we extract stories you can edit" },
  { id: "job", label: "Job posting", hint: "The role you are interviewing for" },
  { id: "company", label: "Company", hint: "Product, culture, and interviewer notes" },
  { id: "notes", label: "Notes", hint: "Anything else the copilot should remember" },
];

export type AccountPlan = "free" | "hosted" | "byok" | "pro";

export type BillingKind = "hosted" | "byok";

export type BillingPlan = {
  id: string;
  name: string;
  kind: BillingKind;
  priceCents: number;
  priceLabel: string;
  interval: "month";
  blurb: string;
  features: string[];
};

export type BillingAccount = {
  plan: AccountPlan;
  label: string;
  status: "free" | "active" | "past_due" | "canceled" | "inactive";
  renewsAt: string | null;
  features: string[];
  stripeEnabled: boolean;
  key: {
    configured: boolean;
    provider: string | null;
    last4: string | null;
    baseUrl: string | null;
  };
  catalog: BillingPlan[];
};

export const STORY_TAGS = [
  "ownership",
  "conflict",
  "failure",
  "leadership",
  "performance",
  "system",
  "collaboration",
  "initiative",
  "customer",
  "learning",
] as const;

export type StoryTag = (typeof STORY_TAGS)[number];

export type StoriesStatus = "empty" | "extracting" | "ready" | "error";

/** One approved interview story. Live answers pick a named card, not a resume chunk. */
export type Story = {
  id: string;
  name: string;
  tags: string[];
  situation: string;
  action: string;
  result: string;
  forbidden: string;
  signals: string[];
  rehearsedAt?: string | null;
  rehearsalCount?: number;
};

export {
  LIMITS,
  GuardError,
  sanitizeText,
  sanitizeLine,
  sanitizeSecret,
  sanitizeHttpUrl,
  sanitizeDeviceId,
  sanitizeUuid,
  optionalUuid,
  allowlist,
  sanitizeJobContext,
} from "./guardrails.js";

export function storyIsRehearsed(story: Pick<Story, "rehearsedAt" | "rehearsalCount">) {
  return Boolean(story.rehearsedAt) || (story.rehearsalCount ?? 0) > 0;
}

/** Facts already said this session. Follow-ups must reuse these. */
export type ClaimsLedger = {
  story: string;
  employer: string;
  people: string[];
  numbers: string[];
  systems: string[];
  facts: string[];
};

export function emptyClaims(): ClaimsLedger {
  return {
    story: "",
    employer: "",
    people: [],
    numbers: [],
    systems: [],
    facts: [],
  };
}

export function claimsAreEmpty(ledger: ClaimsLedger) {
  return (
    !ledger.story &&
    !ledger.employer &&
    ledger.people.length === 0 &&
    ledger.numbers.length === 0 &&
    ledger.systems.length === 0 &&
    ledger.facts.length === 0
  );
}

export function formatClaims(ledger: ClaimsLedger) {
  if (claimsAreEmpty(ledger)) return "";
  return [
    ledger.story ? `Story in play: ${ledger.story}` : "",
    ledger.employer ? `Employer: ${ledger.employer}` : "",
    ledger.people.length ? `People: ${ledger.people.join(", ")}` : "",
    ledger.numbers.length ? `Numbers: ${ledger.numbers.join("; ")}` : "",
    ledger.systems.length ? `Systems: ${ledger.systems.join(", ")}` : "",
    ledger.facts.length ? `Said: ${ledger.facts.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type InterviewTrackId =
  | "auto"
  | "software"
  | "data"
  | "product"
  | "design"
  | "consulting"
  | "finance"
  | "sales"
  | "marketing"
  | "general";

export const INTERVIEW_TRACKS: { id: InterviewTrackId; label: string; hint: string }[] = [
  { id: "auto", label: "Auto-detect", hint: "Routes every question to the best specialist" },
  { id: "software", label: "Software engineering", hint: "Coding, system design, technical depth" },
  { id: "data", label: "Data & analytics", hint: "SQL, statistics, ML, metrics" },
  { id: "product", label: "Product management", hint: "Product sense, execution, metrics" },
  { id: "design", label: "Design & UX", hint: "Portfolio, critique, design process" },
  { id: "consulting", label: "Consulting & case", hint: "Cases, market sizing, frameworks" },
  { id: "finance", label: "Finance & banking", hint: "Accounting, valuation, markets" },
  { id: "sales", label: "Sales & customer success", hint: "Pitches, objections, role plays" },
  { id: "marketing", label: "Marketing & growth", hint: "Campaigns, funnels, positioning" },
  { id: "general", label: "General / any role", hint: "Behavioral and motivation questions" },
];

/** Where you are in the loop. Industry stays on Home; this is the HUD control. */
export type InterviewStageId =
  | "auto"
  | "intro"
  | "behavioral"
  | "technical"
  | "coding"
  | "system_design"
  | "case"
  | "wrap";

export const INTERVIEW_STAGES: { id: InterviewStageId; label: string; hint: string }[] = [
  { id: "auto", label: "Auto stage", hint: "Infers intro / coding / design from the conversation" },
  { id: "intro", label: "Intro", hint: "About you, why this role, strengths" },
  { id: "behavioral", label: "Behavioral", hint: "STAR stories, conflict, ownership" },
  { id: "technical", label: "Technical", hint: "Concepts, language, internals" },
  { id: "coding", label: "Coding", hint: "Live code, algorithms, SQL" },
  { id: "system_design", label: "System design", hint: "Architecture, scale, tradeoffs" },
  { id: "case", label: "Case / product", hint: "Cases, metrics, product sense" },
  { id: "wrap", label: "Close", hint: "Your questions, recap, next steps" },
];

/** One beat in a Home practice drill against this role. */
export type PracticeQuestion = {
  id: string;
  text: string;
  kind: string;
  stage: InterviewStageId;
  storyId?: string;
  storyName?: string;
  probe?: string;
};

export type ListenMode = "auto" | "shortcut";
export type AudioSource = "system" | "mic";

export type AssistAction =
  | "assist"
  | "ask"
  | "screen"
  | "say_next"
  | "follow_up"
  | "fact_check"
  | "recap";

export type ClientEvent =
  | {
      type: "meeting.started";
      sessionId?: string;
      resumeId?: string;
      jobContext?: JobContext;
      track?: InterviewTrackId;
      stage?: InterviewStageId;
      listenMode?: ListenMode;
    }
  | { type: "meeting.ended"; sessionId: string }
  | {
      type: "session.config";
      /** Omitted outside a session: applies to the connection's Assist scratchpad. */
      sessionId?: string;
      track?: InterviewTrackId;
      stage?: InterviewStageId;
      listenMode?: ListenMode;
      modeId?: string;
    }
  | {
      type: "audio.utterance";
      sessionId: string;
      timestamp: number;
      mimeType: string;
      data: string;
      durationMs: number;
      source: AudioSource;
      /** Captured with the listen shortcut: answer it without waiting for question detection. */
      force?: boolean;
    }
  | {
      /** Arms live transcription. Raw PCM16/24kHz frames follow as binary WS messages. */
      type: "listen.start";
      sessionId: string;
      source: AudioSource;
      track?: InterviewTrackId;
      stage?: InterviewStageId;
    }
  | { type: "listen.stop"; sessionId: string }
  | {
      /** Force-finalizes whatever audio has buffered (shortcut mode, second press). */
      type: "listen.commit";
      sessionId: string;
    }
  | {
      type: "assist.request";
      /** Omitted outside a session: Assist runs on the connection's unsaved scratchpad. */
      sessionId?: string;
      action: AssistAction;
      text?: string;
      imageBase64?: string;
      mimeType?: string;
      transcript?: string;
      images?: { imageBase64: string; mimeType?: string }[];
      smart?: boolean;
    }
  | { type: "context.clear"; sessionId?: string }
  | {
      type: "transcript.partial";
      sessionId: string;
      timestamp: number;
      text: string;
    }
  | {
      type: "transcript.final";
      sessionId: string;
      timestamp: number;
      text: string;
    }
  | {
      type: "screen.changed";
      sessionId: string;
      timestamp: number;
      ocrText: string;
      imageRef?: string;
      imageBase64?: string;
      mimeType?: string;
      diffRatio?: number;
    }
  | { type: "meeting.app"; sessionId: string; app: string }
  | { type: "ping"; timestamp: number };

export type ServerEvent =
  | { type: "hello"; message: string }
  | { type: "pong"; timestamp: number }
  | { type: "session.ready"; sessionId: string }
  | { type: "session.ended"; sessionId: string }
  | { type: "session.saved"; sessionId: string; kind: string }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string; source?: AudioSource }
  | { type: "transcript.interpreted"; text: string }
  | { type: "turn.pending"; text: string }
  | { type: "listen.state"; sessionId: string; active: boolean }
  | {
      type: "question.detected";
      questionId: string;
      kind: string;
      agent: string;
      text: string;
      source: "audio" | "screen" | "assist";
      /** True when the answer solves what is on screen; false when a screenshot was only background. */
      screen?: boolean;
    }
  | { type: "question.updated"; questionId: string; text: string }
  | { type: "answer.started"; questionId: string }
  | { type: "answer.delta"; questionId: string; text: string }
  | { type: "answer.completed"; questionId: string; text?: string }
  | {
      type: "answer.flag";
      questionId: string;
      kind: "invented" | "contradicts";
      confidence: number;
      sentence?: string;
      replacement?: string;
    }
  | { type: "answer.cancelled"; questionId: string }
  | {
      type: "screen.insight";
      kind: "code" | "slide" | "docs" | "browser" | "idle" | "other";
      title: string;
      text: string;
      ocrText?: string;
    }
  | { type: "summary.rolling"; text: string }
  | { type: "session.summary"; sessionId: string; text: string }
  | { type: "context.cleared"; sessionId: string }
  | { type: "meeting.app"; app: string; coach: string }
  | { type: "session.error"; code: string; message: string }
  | { type: "session.stage"; stage: InterviewStageId; inferred: boolean }
  | { type: "intent.held"; intent: "probe" | "hint"; text: string };

export const WS_PATH = "/ws";
export const DEFAULT_API_PORT = 8787;

export type AnswerLadder = {
  gist: string;
  say: string;
  push: string;
  trap: string;
};

function markerName(line: string): keyof Omit<AnswerLadder, "gist"> | null {
  const token = line.trim().replace(/^[#*_:\-\s]+|[#*_:\-\s]+$/g, "").toUpperCase();
  if (token === "SAY") return "say";
  if (token === "PUSH") return "push";
  if (token === "TRAP") return "trap";
  return null;
}

function wordCount(line: string) {
  return line.trim().split(/\s+/).filter(Boolean).length;
}

/** Split a streamed answer into gist / say-now / if-they-push / trap. */
export function parseLadder(text: string): AnswerLadder {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: AnswerLadder = { gist: "", say: "", push: "", trap: "" };
  if (!lines.length) return out;

  let i = 0;
  const first = lines[0].trim();
  if (
    first &&
    !markerName(first) &&
    wordCount(first) <= 8 &&
    !first.includes("```")
  ) {
    out.gist = first;
    i = 1;
    if (lines[1] === "") i = 2;
  }

  type Layer = keyof Omit<AnswerLadder, "gist">;
  let section: Layer = "say";
  const buckets: Record<Layer, string[]> = {
    say: [],
    push: [],
    trap: [],
  };
  for (; i < lines.length; i += 1) {
    const mark = markerName(lines[i]);
    if (mark) {
      section = mark;
      continue;
    }
    buckets[section].push(lines[i]);
  }
  out.say = buckets.say.join("\n").trim();
  out.push = buckets.push.join("\n").trim();
  out.trap = buckets.trap.join("\n").trim();
  return out;
}

function isTitleGist(gist: string) {
  const t = gist.trim();
  if (!t) return true;
  if (/^(hello|helo|hi|hey|thanks|ok|okay)\b/i.test(t)) return true;
  if (/^(understanding|explaining|overview|introduction|what is)\b/i.test(t)) return true;
  return false;
}

/** The part of an answer the HUD displays: the gist (unless it is only a title), SAY, and PUSH. TRAP stays hidden. */
export function spokenAnswer(text: string) {
  const ladder = parseLadder(text);
  const parts = [
    ladder.gist && !isTitleGist(ladder.gist) ? ladder.gist : "",
    ladder.say,
    ladder.push,
  ].filter(Boolean);
  return parts.join("\n\n") || text;
}
