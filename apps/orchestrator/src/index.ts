import { randomUUID } from "node:crypto";
import { LIMITS, sanitizeText } from "@meeting-copilot/types";
import {
  extractLatestQuestion,
  isCandidateSpeech,
  isCheckIn,
  isLikelyNewQuestion,
  isNoiseTranscript,
  isQuestionLike,
  looksLikeInterviewer,
  normalizeQuestion,
  overlapsAnswer,
  sameQuestion,
} from "./questions.js";
import { aiStatus, models, runWithAi, type AiCreds } from "./llm/client.js";
import { completeChat } from "./llm/chat.js";
import { analyzeScreen, type ScreenAnalysis } from "./llm/vision.js";
import { ASK_TITLE_PROMPT, ASSIST_SCREEN_ASK, KNOWLEDGE_IN_BRIEF } from "./llm/prompts.js";
import { chunkKnowledge, pickKnowledge } from "./modeKnowledge.js";
import { fixUnsupported, flagFromScores, scoreGrounding } from "./grounding.js";
import { jevEnabled } from "./llm/jev.js";
import {
  classifyTurn,
  resolveSpecialist,
  specialistNeedsRag,
  streamAnswer,
  summarizeInterview,
  spokenBody,
  toSpoken,
} from "./engine.js";
import { formatStory, specialistNeedsStory } from "./stories.js";
import { formatPacketPrompt, type ScreenPacket } from "./screenPacket.js";
import { RealtimeTranscriber } from "./stt/realtime.js";
import { WhisperTranscriber } from "./stt/whisper.js";
import { TurnAssembler } from "./turns.js";
import { isFollowUp, routeQuestion } from "./agents/router.js";
import { getTrack } from "./agents/tracks.js";
import {
  classifyIntent,
  effectiveStage,
  inferStage,
  isShallowProbe,
  type InterviewerIntent,
} from "./intent.js";
import { assistPrompt } from "./actions.js";
import { buildConversation, pickAssistTarget } from "./assist.js";
import {
  emptyClaims,
  formatClaims,
  type AssistAction,
  type AudioSource,
  type ClaimsLedger,
  type InterviewStageId,
  type InterviewTrackId,
  type ListenMode,
  type Story,
} from "@meeting-copilot/types";
import {
  heuristicClaims,
  isFollowUpQuestion,
  pickLockedStory,
  refineClaims,
} from "./claims.js";

type Turn = { question: string; kind: string; answer: string; at: number };

/** One finished stretch of transcribed speech, kept for the whole session. */
type Segment = { at: number; text: string; source: AudioSource };

type ScreenCtx = ScreenAnalysis & { at: number };

type SessionMemory = {
  startedAt: number;
  /** Every transcribed segment this session, oldest first. */
  transcript: Segment[];
  /** Text the live transcriber has streamed for speech that has not finished yet. */
  partial: string;
  /** Speech up to this moment was already answered; anything later is the new ask. */
  answeredAt: number;
  /** Bumped by every Assist request; an answer whose generation is stale stops streaming. */
  generation: number;
  recent: string[];
  cleanRecent: string[];
  lastQuestion: string;
  lastAskedAt: number;
  answering: boolean;
  warnedNoKey: boolean;
  turns: Turn[];
  speakingUntil: number;
  screen?: ScreenCtx;
  lastVisionAt: number;
  visionBusy: boolean;
  rollingSummary: string;
  lastSummaryTurns: number;
  track: InterviewTrackId;
  stage: InterviewStageId;
  inferredStage: InterviewStageId;
  listenMode: ListenMode;
  brief: string;
  briefPromise?: Promise<void>;
  knowledge: string[];
  stories: Story[];
  claims: ClaimsLedger;
  pendingTurn: string;
  ai?: AiCreds | null;
  job: {
    title?: string | null;
    company?: string | null;
    requirements?: string | null;
  };
  screenPacket?: ScreenPacket;
  pendingScreen?: { imageBase64: string; mimeType?: string; diffRatio?: number };
};

const memory = new Map<string, SessionMemory>();

function mem(sessionId: string): SessionMemory {
  const existing = memory.get(sessionId);
  if (existing) return existing;
  const created: SessionMemory = {
    startedAt: Date.now(),
    transcript: [],
    partial: "",
    answeredAt: 0,
    generation: 0,
    recent: [],
    cleanRecent: [],
    lastQuestion: "",
    lastAskedAt: 0,
    answering: false,
    warnedNoKey: false,
    turns: [],
    speakingUntil: 0,
    lastVisionAt: 0,
    visionBusy: false,
    rollingSummary: "",
    lastSummaryTurns: 0,
    track: "auto",
    stage: "auto",
    inferredStage: "auto",
    listenMode: "auto",
    brief: "",
    knowledge: [],
    stories: [],
    claims: emptyClaims(),
    pendingTurn: "",
    job: {},
  };
  memory.set(sessionId, created);
  return created;
}

export function setSessionTrack(sessionId: string, track?: InterviewTrackId) {
  if (!track) return;
  mem(sessionId).track = track;
}

export function configureSession(
  sessionId: string,
  cfg: {
    track?: InterviewTrackId;
    stage?: InterviewStageId;
    listenMode?: ListenMode;
    modeId?: string;
  },
) {
  const state = mem(sessionId);
  if (cfg.track) state.track = cfg.track;
  if (cfg.stage) state.stage = cfg.stage;
  if (cfg.listenMode) state.listenMode = cfg.listenMode;
  if (cfg.modeId) {
    state.brief = "";
    state.knowledge = [];
    state.briefPromise = undefined;
  }
}

type LoadedProfile = {
  brief: string;
  job: { title?: string | null; company?: string | null; requirements?: string | null };
  stories?: Story[];
  knowledge?: string;
};

function applyProfile(state: SessionMemory, loaded: LoadedProfile) {
  state.brief = loaded.brief;
  state.job = loaded.job;
  state.stories = loaded.stories ?? [];
  const knowledge = loaded.knowledge ?? "";
  state.knowledge = knowledge.length > KNOWLEDGE_IN_BRIEF ? chunkKnowledge(knowledge) : [];
}

export function hydrateSessionProfile(sessionId: string, loaded: LoadedProfile) {
  applyProfile(mem(sessionId), loaded);
}

export function clearSessionMemory(sessionId: string) {
  memory.delete(sessionId);
  stopListening(sessionId);
}

/** Decide whether a turn is worth answering, and which specialist should answer it. */
function sessionStage(
  state: SessionMemory,
  text?: string,
  specialistId?: string,
) {
  if (state.stage !== "auto") return state.stage;
  const guess = text ? inferStage(text, specialistId) : null;
  return effectiveStage(state.stage, guess ?? state.inferredStage);
}

function pickQuestion(text: string, track: InterviewTrackId, stage?: InterviewStageId) {
  if (!isQuestionLike(text)) {
    return { isQuestion: false as const, kind: "other", text };
  }
  const specialist = routeQuestion(text, track, undefined, stage);
  return { isQuestion: true as const, kind: specialist.id, text };
}

function formatScreenContext(screen?: ScreenCtx, packet?: ScreenPacket) {
  if (packet && (packet.passage || packet.questions.length)) {
    return formatPacketPrompt(packet, packet.questions, {
      imageHasQuestions: packet.questions.length > 0,
    });
  }
  if (!screen || Date.now() - screen.at > 5 * 60_000) return "";
  const parts = [
    screen.title && `Title: ${screen.title}`,
    screen.language && `Language: ${screen.language}`,
    screen.signature && `Signature: ${screen.signature}`,
    screen.passage && `Statement: ${screen.passage}`,
    screen.questions.length
      ? `Questions:\n${screen.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "",
    screen.problem && `Problem: ${screen.problem}`,
    screen.ocrText && `Text: ${screen.ocrText}`,
  ].filter(Boolean);
  return parts.join("\n");
}

type CueOpts = {
  imageBase64?: string;
  mimeType?: string;
  groundToScreen?: boolean;
  maxTokens?: number;
  /** Shown in the HUD instead of the prompt text. */
  displayText?: string;
  /** Resolves to a readable question title that replaces displayText once known. */
  questionTitle?: Promise<string | null>;
  /** The whole conversation so far, from buildConversation. */
  conversation?: string;
  /** The Assist request this answer belongs to; a newer one replaces it. */
  generation?: number;
  /** Smart Mode: think harder before answering. */
  deep?: boolean;
};

function screenTitle(analysis: ScreenAnalysis) {
  const firstLine = (text: string) => text.split(/\n|(?<=[.?!])\s/)[0]?.trim() ?? "";
  const pick =
    analysis.title.trim() ||
    analysis.questions[0] ||
    firstLine(analysis.problem) ||
    firstLine(analysis.ocrText);
  return pick ? pick.slice(0, 160) : null;
}

type AnswerExtras = {
  ai?: AiCreds | null;
  resumeContext?: (
    question: string,
    opts?: { k?: number },
  ) => Promise<{
    context: string;
    job: { title?: string | null; company?: string | null; requirements?: string | null };
  }>;
  candidateBrief?: () => Promise<LoadedProfile>;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.then((value) => value, () => null),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    }),
  ]);
}

async function ensureBrief(sessionId: string, extras?: AnswerExtras) {
  const state = mem(sessionId);
  if (!extras?.candidateBrief) return;
  if (state.brief) return;
  if (!state.briefPromise) {
    state.briefPromise = extras
      .candidateBrief()
      .then((loaded) => applyProfile(state, loaded))
      .catch(() => {
        state.briefPromise = undefined;
      });
  }
  await state.briefPromise;
}

function withSessionAi<T>(sessionId: string, fn: () => T): T {
  return runWithAi(mem(sessionId).ai, fn);
}

/** Most segments one session keeps. A long interview is a few hundred. */
const TRANSCRIPT_MAX = 6_000;
/** Longest wait for the transcriber to finish the words said just before Assist. */
const SETTLE_MS = 1_600;

/** Finish transcribing the last thing said, so Assist sees it. No-op when not listening. */
async function settleSpeech(sessionId: string) {
  const session = listening.get(sessionId);
  if (!session?.transcriber.flush || recovering.has(sessionId)) return;
  try {
    await session.transcriber.flush(SETTLE_MS);
  } catch {
    /* answer with what we have */
  }
}

/** A short readable title for what was just asked, shown in the HUD once known. */
async function titleLatestAsk(sessionId: string, said: string): Promise<string | null> {
  const text = said.trim().slice(-1_500);
  if (!text) return null;
  try {
    const raw = await withSessionAi(sessionId, () =>
      completeChat({
        system: ASK_TITLE_PROMPT,
        user: text,
        model: models().nano,
        temperature: 0,
        maxTokens: 80,
      }),
    );
    const title = raw.trim().replace(/^["'“]+|["'”]+$/g, "");
    if (!title || /^none\.?$/i.test(title)) return null;
    return title.slice(0, 200);
  } catch {
    return null;
  }
}

async function streamCueCard(
  sessionId: string,
  classified: { kind: string; text: string; intent?: InterviewerIntent },
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras?: AnswerExtras,
  source: "audio" | "screen" | "assist" = "audio",
  smart = false,
  opts?: CueOpts,
) {
  const state = mem(sessionId);
  if (extras?.ai) state.ai = extras.ai;
  return withSessionAi(sessionId, () =>
    streamCueCardInner(sessionId, classified, emit, extras, source, smart, opts),
  );
}

/** Streams one answer. Resolves true when it finished, false when skipped, replaced, or failed. */
async function streamCueCardInner(
  sessionId: string,
  classified: { kind: string; text: string; intent?: InterviewerIntent },
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras?: AnswerExtras,
  source: "audio" | "screen" | "assist" = "audio",
  smart = false,
  opts?: CueOpts,
): Promise<boolean> {
  const state = mem(sessionId);
  const key = normalizeQuestion(classified.text);
  const cooldown = source === "assist" ? 0 : source === "screen" ? 40_000 : 25_000;
  if (
    cooldown > 0 &&
    sameQuestion(key, state.lastQuestion) &&
    Date.now() - state.lastAskedAt < cooldown
  ) {
    return false;
  }
  if (state.answering && source !== "assist") return false;
  // The newest Assist wins: an answer still streaming sees the bumped generation and stops.
  const generation = opts?.generation ?? ++state.generation;
  if (generation !== state.generation) return false;

  state.lastQuestion = key;
  state.lastAskedAt = Date.now();
  state.answering = true;
  const questionId = randomUUID();
  const specialist = resolveSpecialist(classified.kind);
  const stage = sessionStage(state, classified.text, specialist.id);
  if (state.stage === "auto" && stage !== "auto" && stage !== state.inferredStage) {
    state.inferredStage = stage;
    await emit({ type: "session.stage", stage, inferred: true });
  }
  const turnRecord: Turn = {
    question: opts?.displayText ?? classified.text,
    kind: classified.kind,
    answer: "",
    at: Date.now(),
  };
  await emit({
    type: "question.detected",
    questionId,
    kind: specialist.id,
    agent: specialist.label,
    text: turnRecord.question,
    source,
  });
  void opts?.questionTitle?.then(async (title) => {
    if (!title || generation !== state.generation) return;
    turnRecord.question = title;
    await emit({ type: "question.updated", questionId, text: title });
  }).catch(() => undefined);
  await emit({ type: "answer.started", questionId });
  try {
    let full = "";
    const groundToScreen = Boolean(opts?.groundToScreen);
    if (!state.brief) await withTimeout(ensureBrief(sessionId, extras), 1500);

    let ragContext = "";
    let picked: Story | null = null;
    if (!groundToScreen && specialistNeedsStory(specialist.id) && state.stories.length) {
      picked = pickLockedStory(classified.text, state.stories, state.claims);
      if (picked) ragContext = formatStory(picked);
    } else if (!groundToScreen && specialistNeedsRag(specialist.id) && extras?.resumeContext) {
      const retrieved = await withTimeout(
        extras.resumeContext(classified.text, { k: 4 }),
        800,
      );
      if (retrieved) {
        ragContext = retrieved.context;
        if (retrieved.job.title || retrieved.job.company) state.job = retrieved.job;
      }
    }

    let replaced = false;
    for await (const delta of streamAnswer({
      question: classified.text,
      specialist,
      track: state.track,
      stage,
      intent: classified.intent,
      brief: state.brief,
      knowledge: state.knowledge,
      ragContext,
      prior: state.turns,
      conversation: opts?.conversation,
      screenContext: formatScreenContext(state.screen, state.screenPacket),
      rollingSummary: state.rollingSummary,
      claims: groundToScreen ? "" : formatClaims(state.claims),
      smart: smart || groundToScreen,
      deep: opts?.deep,
      groundToScreen,
      maxTokens: opts?.maxTokens,
      image: opts?.imageBase64
        ? {
            base64: opts.imageBase64,
            mimeType: opts.mimeType,
            detail: "high",
          }
        : undefined,
    })) {
      if (generation !== state.generation) {
        replaced = true;
        break;
      }
      full += delta;
      await emit({ type: "answer.delta", questionId, text: delta });
    }
    if (replaced) {
      await emit({ type: "answer.cancelled", questionId });
      return false;
    }
    const spoken = toSpoken(full);
    if (!groundToScreen && specialist.id !== "coding" && jevEnabled()) {
      const saidBefore = formatClaims(state.claims);
      const evidence = [
        state.brief ? `Candidate profile and mode:\n${state.brief}` : "",
        ragContext ? `Retrieved for this question:\n${ragContext}` : "",
        state.knowledge.length
          ? `Mode knowledge:\n${pickKnowledge(state.knowledge, classified.text)}`
          : "",
        saidBefore ? `Already said in this interview:\n${saidBefore}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const checkedAt = Date.now();
      void scoreGrounding({ question: classified.text, answer: full, evidence })
        .then(async (scores) => {
          if (!scores) return;
          const flag = flagFromScores(scores);
          console.log(
            `[jev] ${JSON.stringify({ agent: specialist.id, invented: Number(scores.invented.toFixed(2)), contradicts: Number(scores.contradicts.toFixed(2)), ms: Date.now() - checkedAt, flagged: flag?.kind ?? false })}`,
          );
          if (!flag) return;
          await emit({ type: "answer.flag", questionId, ...flag });
          const fix = await withSessionAi(sessionId, () =>
            fixUnsupported({ question: classified.text, answer: full, evidence, kind: flag.kind }),
          );
          console.log(`[jev] ${JSON.stringify({ fix: Boolean(fix), ms: Date.now() - checkedAt })}`);
          if (fix) await emit({ type: "answer.flag", questionId, ...flag, ...fix });
        })
        .catch(() => undefined);
    }
    turnRecord.answer = spoken;
    state.turns.push(turnRecord);
    if (state.turns.length > 200) state.turns.shift();
    state.claims = heuristicClaims({
      answer: spoken,
      story: picked,
      prior: isFollowUpQuestion(classified.text) ? state.claims : emptyClaims(),
    });
    if (!isFollowUpQuestion(classified.text) && picked) {
      state.claims.story = picked.name;
    }
    await emit({ type: "answer.completed", questionId, text: full });
    // Hold the card while you talk it through. Screen-watch and leaked
    // speech should not swap the answer unless a new interviewer question lands.
    state.speakingUntil = Date.now() + (source === "screen" ? 6_000 : 45_000);
    void refreshRollingSummary(sessionId, emit);
    void refreshClaims(sessionId, classified.text, spoken, picked?.name);
    return true;
  } catch (err) {
    if (generation !== state.generation) return false;
    const message = err instanceof Error ? err.message : "Could not write an answer.";
    await emit({
      type: "session.error",
      code: /claude|key/i.test(message) ? "llm_key" : "llm",
      message,
    });
    return false;
  } finally {
    if (generation === state.generation) state.answering = false;
  }
}

async function refreshClaims(
  sessionId: string,
  question: string,
  answer: string,
  storyName?: string,
) {
  const state = mem(sessionId);
  try {
    const refined = await refineClaims({
      question,
      answer,
      prior: state.claims,
      storyName,
    });
    if (refined) state.claims = refined;
  } catch {
    /* keep heuristic ledger */
  }
}

async function refreshRollingSummary(
  sessionId: string,
  emit: (event: Record<string, unknown>) => void | Promise<void>,
) {
  const state = mem(sessionId);
  if (state.turns.length < 3) return;
  if (state.turns.length - state.lastSummaryTurns < 3) return;
  try {
    const text = await summarizeInterview({
      turns: state.turns,
      previous: state.rollingSummary,
      job: state.job,
      final: false,
    });
    if (!text) return;
    state.rollingSummary = text;
    state.lastSummaryTurns = state.turns.length;
    await emit({ type: "summary.rolling", text });
  } catch {
    /* keep the last memory if this pass fails */
  }
}

export async function buildSessionSummary(sessionId: string): Promise<string> {
  const state = memory.get(sessionId);
  if (!state) return "No questions were captured in this session.";
  try {
    return (
      (await summarizeInterview({
        turns: state.turns,
        previous: state.rollingSummary,
        job: state.job,
        final: true,
      })) ||
      state.rollingSummary ||
      "No questions were captured in this session."
    );
  } catch {
    return state.rollingSummary || "Could not write a recap for this session.";
  }
}

// ---------------------------------------------------------------------------
// Live listening: Realtime STT -> turn assembly -> specialist routing
// ---------------------------------------------------------------------------

type AudioTranscriber = {
  appendAudio: (frame: Buffer) => void;
  commit: () => void;
  close: () => void;
  reconnect?: () => Promise<void>;
  /** Finish transcribing what was just said, waiting at most `timeoutMs`. */
  flush?: (timeoutMs: number) => Promise<void>;
};

type ListeningSession = {
  transcriber: AudioTranscriber;
  assembler: TurnAssembler;
  source: AudioSource;
  pending: Buffer[];
  retries: number;
};

const listening = new Map<string, ListeningSession>();
const recovering = new Set<string>();
const recoverTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PENDING_MAX = 30;

function enqueueFrame(session: ListeningSession, frame: Buffer) {
  session.pending.push(frame);
  if (session.pending.length > PENDING_MAX) session.pending.shift();
}

function flushPending(session: ListeningSession) {
  for (const frame of session.pending) session.transcriber.appendAudio(frame);
  session.pending = [];
}

function clearRecoverTimer(sessionId: string) {
  const timer = recoverTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  recoverTimers.delete(sessionId);
}

function scheduleSttRetry(
  sessionId: string,
  err: Error,
  hooks: ConstructorParameters<typeof RealtimeTranscriber>[0],
  emit: (event: Record<string, unknown>) => void | Promise<void>,
) {
  if (!listening.has(sessionId) || recoverTimers.has(sessionId)) return;
  const session = listening.get(sessionId);
  const delay = Math.min(8_000, 400 * 2 ** Math.min(session?.retries ?? 0, 4));
  if (session) session.retries += 1;
  recoverTimers.set(
    sessionId,
    setTimeout(() => {
      recoverTimers.delete(sessionId);
      void recoverStt(sessionId, err, hooks, emit);
    }, delay),
  );
}

async function recoverStt(
  sessionId: string,
  err: Error,
  hooks: ConstructorParameters<typeof RealtimeTranscriber>[0],
  emit: (event: Record<string, unknown>) => void | Promise<void>,
) {
  return withSessionAi(sessionId, () => recoverSttInner(sessionId, err, hooks, emit));
}

async function recoverSttInner(
  sessionId: string,
  err: Error,
  hooks: ConstructorParameters<typeof RealtimeTranscriber>[0],
  emit: (event: Record<string, unknown>) => void | Promise<void>,
) {
  const session = listening.get(sessionId);
  if (!session || recovering.has(sessionId)) return;
  recovering.add(sessionId);
  try {
    if (session.transcriber.reconnect) {
      try {
        await session.transcriber.reconnect();
        session.retries = 0;
        clearRecoverTimer(sessionId);
        flushPending(session);
        await emit({
          type: "session.error",
          code: "stt_fallback",
          message: "Live transcription dropped — reconnected. Keep talking.",
        });
        return;
      } catch (reconnectErr) {
        console.error(
          "[stt-reconnect]",
          sessionId.slice(0, 8),
          reconnectErr instanceof Error ? reconnectErr.message : reconnectErr,
        );
        try {
          session.transcriber.close();
        } catch {
          /* already closed */
        }
      }
    }
    try {
      const whisper = new WhisperTranscriber(hooks);
      await whisper.connect();
      session.transcriber = whisper;
      session.retries = 0;
      flushPending(session);
      await emit({
        type: "session.error",
        code: "stt_fallback",
        message: "Live socket dropped — using Whisper. Keep talking; answers will still appear.",
      });
      scheduleRealtimePromote(sessionId, hooks, emit);
      return;
    } catch (fallbackErr) {
      console.error("[stt]", sessionId.slice(0, 8), err.message, fallbackErr);
      await emit({
        type: "session.error",
        code: "stt_network",
        message: "Live transcription dropped — retrying. Keep talking.",
      });
      scheduleSttRetry(sessionId, err, hooks, emit);
    }
  } finally {
    recovering.delete(sessionId);
  }
}

function scheduleRealtimePromote(
  sessionId: string,
  hooks: ConstructorParameters<typeof RealtimeTranscriber>[0],
  emit: (event: Record<string, unknown>) => void | Promise<void>,
) {
  clearRecoverTimer(sessionId);
  recoverTimers.set(
    sessionId,
    setTimeout(() => {
      recoverTimers.delete(sessionId);
      void promoteToRealtime(sessionId, hooks, emit);
    }, 12_000),
  );
}

async function promoteToRealtime(
  sessionId: string,
  hooks: ConstructorParameters<typeof RealtimeTranscriber>[0],
  emit: (event: Record<string, unknown>) => void | Promise<void>,
) {
  const session = listening.get(sessionId);
  if (!session) return;
  if (session.transcriber.reconnect) return;
  if (recovering.has(sessionId)) {
    scheduleRealtimePromote(sessionId, hooks, emit);
    return;
  }
  const next = new RealtimeTranscriber(hooks);
  try {
    await next.connect();
    try {
      session.transcriber.close();
    } catch {
      /* whisper */
    }
    session.transcriber = next;
    session.retries = 0;
    await emit({
      type: "session.error",
      code: "stt_fallback",
      message: "Back on live transcription.",
    });
  } catch {
    next.close();
    scheduleRealtimePromote(sessionId, hooks, emit);
  }
}

function holdingLiveAnswer(sessionId: string) {
  const state = mem(sessionId);
  return state.answering || Date.now() < state.speakingUntil;
}

type Decided =
  | { isQuestion: true; kind: string; text: string; intent: InterviewerIntent }
  | { isQuestion: false; hold?: "probe" | "hint"; text?: string };

async function decideQuestion(
  sessionId: string,
  text: string,
  force: boolean,
  source: AudioSource,
): Promise<Decided> {
  const state = mem(sessionId);
  const lastAnswer = state.turns[state.turns.length - 1]?.answer ?? "";
  const holding = holdingLiveAnswer(sessionId);
  const latest = extractLatestQuestion(text);
  const intent = classifyIntent(latest, { hasTurns: state.turns.length > 0 });
  if (intent === "check_in" || intent === "ignore") return { isQuestion: false };
  if (!force && state.turns.length && (intent === "hint" || isShallowProbe(latest))) {
    return { isQuestion: false, hold: intent === "hint" ? "hint" : "probe", text: latest };
  }
  if (intent === "feedback" || intent === "wrap") {
    const stage = sessionStage(state, latest);
    const specialist = routeQuestion(latest, state.track, undefined, stage);
    return { isQuestion: true, kind: specialist.id, text: latest, intent };
  }
  // Mic always mixes both voices. After we already answered, also ignore
  // first-person / echoed speech on system audio so the card does not jump.
  if (source === "mic" || holding) {
    if (isCandidateSpeech(latest)) return { isQuestion: false };
    if (
      lastAnswer &&
      overlapsAnswer(latest, spokenBody(lastAnswer)) &&
      !isLikelyNewQuestion(latest)
    ) {
      return { isQuestion: false };
    }
  }
  if (holding && !force && !isLikelyNewQuestion(latest)) {
    return { isQuestion: false };
  }
  if (source === "mic" && Date.now() < state.speakingUntil && !looksLikeInterviewer(latest)) {
    return { isQuestion: false };
  }

  const stage = sessionStage(state, latest);

  if (force) {
    const specialist = routeQuestion(latest, state.track, undefined, stage);
    return { isQuestion: true, kind: specialist.id, text: latest, intent };
  }

  const heuristic = pickQuestion(latest, state.track, stage);
  if (heuristic.isQuestion) return { ...heuristic, intent };

  const words = latest.trim().split(/\s+/).filter(Boolean);
  if (words.length < 6 || isNoiseTranscript(latest)) return { isQuestion: false };

  try {
    const guessed = await classifyTurn(latest);
    if (guessed?.isQuestion) {
      const specialist = routeQuestion(latest, state.track, guessed.kind, stage);
      return { isQuestion: true, kind: specialist.id, text: latest, intent };
    }
  } catch {
    /* fall through */
  }
  return { isQuestion: false };
}

const startingListen = new Set<string>();

export async function startListening(
  sessionId: string,
  opts: {
    source: AudioSource;
    track?: InterviewTrackId;
    stage?: InterviewStageId;
    listenMode?: ListenMode;
  },
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras?: AnswerExtras,
) {
  if (listening.has(sessionId) || startingListen.has(sessionId)) return;
  startingListen.add(sessionId);
  try {
  const state = mem(sessionId);
  if (extras?.ai) state.ai = extras.ai;
  const status = withSessionAi(sessionId, () => aiStatus());
  if (!status.stt) {
    const named = status.provider === "claude" || status.provider === "grok";
    const label = status.provider === "grok" ? "Grok" : "Claude";
    await emit({
      type: "session.error",
      code: status.llm && named ? "need_stt" : "no_ai_key",
      message:
        status.llm && named
          ? `${label} can write answers. Type the question or press Assist — live listen needs a speech key.`
          : "The server has no AI key configured, so live listening can't start.",
    });
    return;
  }
  configureSession(sessionId, {
    track: opts.track,
    stage: opts.stage,
    listenMode: opts.listenMode,
  });
  const track = getTrack(state.track);
  const source = opts.source;

  const assembler = new TurnAssembler({
    onPending: (text) => {
      state.pendingTurn = text;
      void emit({ type: "turn.pending", text });
    },
    onFinalTurn: (text, force) => {
      withSessionAi(sessionId, () => {
      // Mic fallback hears both sides mixed together; filter out our own
      // voice. System-audio capture only ever hears the interviewer, so
      // that check is skipped for the system source.
      void decideQuestion(sessionId, text, Boolean(force), source).then((classified) => {
        if (!classified.isQuestion) {
          if (classified.hold) {
            void emit({
              type: "intent.held",
              intent: classified.hold,
              text: classified.text ?? text,
            });
            return;
          }
          if (isQuestionLike(text)) {
            console.error("[turn-drop]", sessionId.slice(0, 8), text.slice(0, 140));
          }
          return;
        }
        if (state.answering) {
          console.error("[turn-busy]", sessionId.slice(0, 8), classified.text.slice(0, 140));
          return;
        }
        state.lastQuestion = classified.text;
        state.lastAskedAt = Date.now();
        state.pendingTurn = classified.text;
      });
      });
    },
  });

  const hooks = {
    vocabulary: track.vocabulary,
    onPartial: (text: string) => {
      state.partial = `${state.partial}${text}`.slice(-2_000);
      void emit({ type: "transcript.partial", text });
    },
    onSegment: (text: string) => {
      state.partial = "";
      state.transcript.push({ at: Date.now(), text, source });
      if (state.transcript.length > TRANSCRIPT_MAX) state.transcript.shift();
      state.recent.push(text);
      if (state.recent.length > 16) state.recent.shift();
      void emit({ type: "transcript.final", text, source });
      assembler.handleSegment(text);
    },
    onSpeechStart: () => assembler.handleSpeechStart(),
    onSpeechStop: () => assembler.handleSpeechStop(),
    onError: (err: Error) => {
      console.error("[stt]", sessionId.slice(0, 8), err.message);
      void recoverStt(sessionId, err, hooks, emit);
    },
  };

  let transcriber: AudioTranscriber | null = null;
  let mode: "realtime" | "whisper" | "buffer" = "realtime";
  const realtime = new RealtimeTranscriber(hooks);
  try {
    await realtime.connect();
    transcriber = realtime;
  } catch (err) {
    realtime.close();
    const message = err instanceof Error ? err.message : String(err);
    console.error("[realtime-stt]", sessionId.slice(0, 8), message);
    if (/401|invalid api key|incorrect api key/i.test(message)) {
      await emit({
        type: "session.error",
        code: "no_ai_key",
        message: "The server's AI key was rejected, so live transcription can't start. Check OPENAI_API_KEY on the server.",
      });
      await emit({ type: "listen.state", sessionId, active: false });
      return;
    }
    try {
      const whisper = new WhisperTranscriber(hooks);
      await whisper.connect();
      transcriber = whisper;
      mode = "whisper";
      await emit({
        type: "session.error",
        code: "stt_fallback",
        message: "Live socket failed — using Whisper. Keep talking; answers will still appear.",
      });
    } catch (fallbackErr) {
      const fallback =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.error("[stt-start]", sessionId.slice(0, 8), fallback);
      transcriber = {
        appendAudio: () => undefined,
        commit: () => undefined,
        close: () => undefined,
      };
      mode = "buffer";
      await emit({
        type: "session.error",
        code: "stt_network",
        message: "Could not start live transcription — retrying. Keep talking.",
      });
    }
  }

  listening.set(sessionId, {
    transcriber: transcriber as AudioTranscriber,
    assembler,
    source,
    pending: [],
    retries: 0,
  });
  void ensureBrief(sessionId, extras);
  await emit({ type: "listen.state", sessionId, active: true });
  if (mode === "whisper") scheduleRealtimePromote(sessionId, hooks, emit);
  if (mode === "buffer") scheduleSttRetry(sessionId, new Error("start"), hooks, emit);
  } finally {
    startingListen.delete(sessionId);
  }
}

/** One ~100ms frame of PCM16/24kHz mono audio from the renderer. */
export function pushAudioFrame(sessionId: string, frame: Buffer) {
  const session = listening.get(sessionId);
  if (!session) return;
  enqueueFrame(session, frame);
  if (recovering.has(sessionId)) return;
  session.transcriber.appendAudio(frame);
}

/** Shortcut "commit" press: answer whatever has been heard so far, right now. */
export function commitListening(sessionId: string) {
  const session = listening.get(sessionId);
  session?.transcriber.commit();
  session?.assembler.commitNow();
}

export function stopListening(sessionId: string) {
  const session = listening.get(sessionId);
  if (!session) return false;
  recovering.delete(sessionId);
  clearRecoverTimer(sessionId);
  session.transcriber.close();
  session.assembler.reset();
  listening.delete(sessionId);
  return true;
}

export function isListening(sessionId: string) {
  return listening.has(sessionId);
}

// ---------------------------------------------------------------------------
// Screen vision
// ---------------------------------------------------------------------------

/** Solve what is on the screenshot, with the conversation so far for constraints and follow-ups. */
async function solveFromScreenshot(
  sessionId: string,
  image: string,
  mimeType: string | undefined,
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras: AnswerExtras | undefined,
  opts: { conversation: string; typedAsk: string; generation: number; deep: boolean },
) {
  const state = mem(sessionId);
  if (extras?.ai) state.ai = extras.ai;
  const questionTitle = withSessionAi(sessionId, () =>
    analyzeScreen(image, mimeType, { detail: "high" }),
  )
    .then((analysis) => {
      if (!analysis || analysis.kind === "idle") return null;
      state.screen = { ...analysis, at: Date.now() };
      return screenTitle(analysis);
    })
    .catch(() => null);
  const ask = opts.typedAsk
    ? `${opts.typedAsk}\n\n(They mean what is on the attached screenshot.)`
    : ASSIST_SCREEN_ASK;
  return streamCueCard(
    sessionId,
    { kind: "coding", text: ask },
    emit,
    extras,
    "assist",
    true,
    {
      imageBase64: image,
      mimeType,
      groundToScreen: true,
      conversation: opts.conversation,
      generation: opts.generation,
      deep: opts.deep,
      displayText: opts.typedAsk || "What's on screen",
      questionTitle: opts.typedAsk ? undefined : questionTitle,
    },
  );
}

export async function handleScreenFrame(
  sessionId: string,
  input: {
    imageBase64?: string;
    mimeType?: string;
    imageRef?: string;
    diffRatio?: number;
  },
  _emit: (event: Record<string, unknown>) => void | Promise<void>,
  _extras?: AnswerExtras,
) {
  const image = input.imageBase64?.trim() ?? "";
  if (image.length < 800) return;
  const state = mem(sessionId);
  state.lastVisionAt = Date.now();
  state.pendingScreen = {
    imageBase64: image,
    mimeType: input.mimeType,
    diffRatio: input.diffRatio,
  };
}

export async function handleAssistRequest(
  sessionId: string,
  input: {
    action: AssistAction;
    text?: string;
    transcript?: string;
    imageBase64?: string;
    images?: { imageBase64: string; mimeType?: string }[];
    mimeType?: string;
    smart?: boolean;
  },
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras?: AnswerExtras,
) {
  const state = mem(sessionId);
  if (extras?.ai) state.ai = extras.ai;
  if (!withSessionAi(sessionId, () => aiStatus().llm)) {
    await emit({
      type: "session.error",
      code: "no_ai_key",
      message: "The server has no AI key configured, so Assist can't answer.",
    });
    return;
  }

  // Claim this request first, so an answer still streaming stops as soon as it sees it.
  const generation = ++state.generation;
  // The answer being replaced no longer owns `answering`, so its finally will not clear it.
  state.answering = false;
  await settleSpeech(sessionId);
  if (generation !== state.generation) return;

  const sentImage = input.images?.[input.images.length - 1]?.imageBase64 || input.imageBase64 || "";
  const latestImage = sentImage || state.pendingScreen?.imageBase64 || "";
  const latestMime =
    input.images?.[input.images.length - 1]?.mimeType ||
    input.mimeType ||
    state.pendingScreen?.mimeType;
  const text = input.text ? sanitizeText(input.text, { max: LIMITS.question }) : "";
  // Typed questions arrive as "ask". Desktop builds before 0.1.6 also attach their own guess at
  // the spoken question to "assist"; that guess can predate the newest speech, so it is only a
  // fallback for when the server heard nothing new itself.
  const typed = input.action === "assist" ? "" : text;
  const spokenHint = input.action === "assist" ? text : "";
  const conversation = buildConversation(state, input.transcript ?? "");
  // Speech transcribed after this point was not part of this answer.
  const heardUpTo = Date.now();
  const target = pickAssistTarget({
    action: input.action,
    typed,
    sentImage: Boolean(sentImage),
    anyImage: Boolean(latestImage),
    freshSpeech: conversation.fresh || spokenHint,
    hasTurns: state.turns.length > 0,
  });
  const deep = Boolean(input.smart);

  if (target.mode === "none") {
    await emit({ type: "session.error", code: "no_prompt", message: target.message });
    return;
  }

  let done = false;
  if (target.mode === "screen") {
    done = await solveFromScreenshot(sessionId, latestImage, latestMime, emit, extras, {
      conversation: conversation.log,
      typedAsk: target.typed,
      generation,
      deep,
    });
  } else {
    const previous = state.turns.at(-1);
    let ask = "";
    let display = "";
    let kind = "general";
    let questionTitle: Promise<string | null> | undefined;
    if (target.mode === "button") {
      const built = assistPrompt(target.action, undefined, "");
      if ("error" in built) return;
      ask = built.text;
      display = built.label;
      kind = built.kind;
    } else if (target.mode === "continue" && previous) {
      ask = `Nothing new has been said since your last answer. Go one layer deeper on "${previous.question}": cover what your last answer left out, with a concrete example. Do not repeat it.`;
      display = `More on: ${previous.question}`.slice(0, 200);
      kind = previous.kind;
    } else {
      const said = target.mode === "typed" ? target.typed : target.mode === "conversation" ? target.said : "";
      ask =
        target.mode === "typed"
          ? said
          : `The newest thing said, which is what to answer now (a question, a request like "tell me about…", or a follow-up to your last answer):\n${said.slice(-3_000)}`;
      display = target.mode === "typed" ? said : (extractLatestQuestion(said) || said).slice(-200);
      if (target.mode === "conversation") questionTitle = titleLatestAsk(sessionId, said);
      const routeText = target.mode === "typed" ? said : extractLatestQuestion(said) || said;
      kind =
        previous && isFollowUp(routeText)
          ? previous.kind
          : routeQuestion(routeText, state.track, undefined, sessionStage(state, routeText)).id;
    }
    // A typed question only carries the screen when the HUD judged it was about the screen.
    const image = target.mode === "typed" ? sentImage : latestImage;
    done = await streamCueCard(
      sessionId,
      { kind, text: ask },
      emit,
      extras,
      "assist",
      true,
      {
        displayText: display,
        questionTitle,
        conversation: conversation.log,
        generation,
        deep,
        ...(image ? { imageBase64: image, mimeType: latestMime, groundToScreen: false } : {}),
      },
    );
  }
  if (done) state.answeredAt = Math.max(state.answeredAt, heardUpTo);
}

/** Clears live memory but keeps the session and the audio connection. */
export function resetLiveContext(sessionId: string) {
  const state = mem(sessionId);
  state.generation += 1;
  state.answering = false;
  state.transcript = [];
  state.partial = "";
  state.answeredAt = 0;
  state.startedAt = Date.now();
  state.recent = [];
  state.cleanRecent = [];
  state.lastQuestion = "";
  state.lastAskedAt = 0;
  state.turns = [];
  state.screen = undefined;
  state.screenPacket = undefined;
  state.pendingScreen = undefined;
  state.rollingSummary = "";
  state.lastSummaryTurns = 0;
  state.brief = "";
  state.briefPromise = undefined;
  state.stories = [];
  state.claims = emptyClaims();
  state.inferredStage = "auto";
  state.pendingTurn = "";
  listening.get(sessionId)?.assembler.reset();
}

export { aiStatus, runWithAi, type AiCreds };
export { verifyModelKey } from "./llm/verifyKey.js";
export { chunkResume, embedTexts, rankChunks } from "./embeddings.js";
export { formatCandidateBrief, collectAnswer } from "./engine.js";
export { extractStack, formatGroundTruth, sliceResumeForBrief } from "./facts.js";
export {
  extractStories,
  formatStory,
  formatStoryCatalog,
  heuristicStories,
  normalizeDraft,
  pickStory,
  specialistNeedsStory,
  type StoryDraft,
} from "./stories.js";
export {
  heuristicClaims,
  isFollowUpQuestion,
  pickLockedStory,
  refineClaims,
} from "./claims.js";
export {
  classifyIntent,
  inferStage,
  isShallowProbe,
} from "./intent.js";
export { buildPracticePlan } from "./practice.js";
export { routeQuestion } from "./agents/router.js";

