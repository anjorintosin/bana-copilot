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
import { aiStatus, runWithAi, type AiCreds } from "./llm/client.js";
import { analyzeScreen, type ScreenAnalysis } from "./llm/vision.js";
import { KNOWLEDGE_IN_BRIEF, assistScreenAsk } from "./llm/prompts.js";
import { chunkKnowledge, pickKnowledge } from "./modeKnowledge.js";
import { flagFromScores, scoreGrounding } from "./grounding.js";
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
import {
  formatPacketPrompt,
  isJunkScreenText,
  looksLikeAlgoProblem,
  looksLikeCompleteCodingProblem,
  markAnswered,
  mergeScreenPacket,
  type ScreenPacket,
} from "./screenPacket.js";
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

type Turn = { question: string; kind: string; answer: string };

type ScreenCtx = ScreenAnalysis & { at: number };

type SessionMemory = {
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

async function streamCueCardInner(
  sessionId: string,
  classified: { kind: string; text: string; intent?: InterviewerIntent },
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras?: AnswerExtras,
  source: "audio" | "screen" | "assist" = "audio",
  smart = false,
  opts?: CueOpts,
) {
  const state = mem(sessionId);
  const key = normalizeQuestion(classified.text);
  const cooldown = source === "assist" ? 0 : source === "screen" ? 40_000 : 25_000;
  if (
    cooldown > 0 &&
    sameQuestion(key, state.lastQuestion) &&
    Date.now() - state.lastAskedAt < cooldown
  ) {
    return;
  }
  if (state.answering) {
    if (source !== "assist") return;
    await emit({
      type: "session.error",
      code: "busy",
      message: "Still answering — try again in a moment.",
    });
    return;
  }

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
  const turnRecord = {
    question: opts?.displayText ?? classified.text,
    kind: classified.kind,
    answer: "",
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
    if (!title) return;
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

    for await (const delta of streamAnswer({
      question: classified.text,
      specialist,
      track: state.track,
      stage,
      intent: classified.intent,
      brief: state.brief,
      knowledge: state.knowledge,
      ragContext,
      prior: groundToScreen ? [] : state.turns,
      screenContext: formatScreenContext(state.screen, state.screenPacket),
      rollingSummary: state.rollingSummary,
      claims: groundToScreen ? "" : formatClaims(state.claims),
      smart: smart || groundToScreen,
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
      full += delta;
      await emit({ type: "answer.delta", questionId, text: delta });
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
        .then((scores) => {
          if (!scores) return;
          const flag = flagFromScores(scores);
          console.log(
            `[jev] ${JSON.stringify({ agent: specialist.id, invented: Number(scores.invented.toFixed(2)), contradicts: Number(scores.contradicts.toFixed(2)), ms: Date.now() - checkedAt, flagged: flag?.kind ?? false })}`,
          );
          return flag ? emit({ type: "answer.flag", questionId, ...flag }) : undefined;
        })
        .catch(() => undefined);
    }
    turnRecord.answer = spoken;
    state.turns.push(turnRecord);
    if (state.turns.length > 20) state.turns.shift();
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not write an answer.";
    await emit({
      type: "session.error",
      code: /claude|key/i.test(message) ? "llm_key" : "llm",
      message,
    });
  } finally {
    state.answering = false;
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
          : "Add your model key on the Plan page.",
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
      void emit({ type: "transcript.partial", text });
    },
    onSegment: (text: string) => {
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
        message: "The model key was rejected. Check the Plan page and try again.",
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

async function solveFromScreenshot(
  sessionId: string,
  image: string,
  mimeType: string | undefined,
  emit: (event: Record<string, unknown>) => void | Promise<void>,
  extras?: AnswerExtras,
  source: "screen" | "assist" = "assist",
  conversation = "",
) {
  const state = mem(sessionId);

  if (source === "assist") {
    const ask = assistScreenAsk(conversation);
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
    await streamCueCard(
      sessionId,
      {
        kind: "coding",
        text: ask,
      },
      emit,
      extras,
      source,
      true,
      {
        imageBase64: image,
        mimeType,
        groundToScreen: true,
        displayText: "What's on screen",
        questionTitle,
      },
    );
    return;
  }

  let analysis: ScreenAnalysis | null = null;
  try {
    analysis = await analyzeScreen(image, mimeType, { detail: "high" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/401|invalid api key|incorrect api key/i.test(message)) {
      await emit({
        type: "session.error",
        code: "no_ai_key",
        message: "The model key was rejected. Check the Plan page and try again.",
      });
      return;
    }
  }

  let fresh: { key: string; text: string }[] = [];
  if (analysis && analysis.kind !== "idle") {
    const merged = mergeScreenPacket(state.screenPacket, analysis);
    state.screenPacket = merged.packet;
    fresh = merged.fresh;
    state.screen = { ...analysis, at: Date.now() };
    const waiting =
      !looksLikeCompleteCodingProblem(analysis) &&
      merged.packet.questions.length === 0 &&
      merged.packet.passage.length >= 40;
    await emit({
      type: "screen.insight",
      kind: analysis.kind,
      title: analysis.title,
      text: waiting
        ? "Statement saved. Scroll down so I can see the questions."
        : (analysis.problem || analysis.ocrText).slice(0, 280),
      ocrText: analysis.ocrText,
    });
  }

  if (source === "screen" && analysis?.kind === "idle") return;
  if (!analysis) {
    if (source === "assist") {
      await emit({
        type: "session.error",
        code: "no_prompt",
        message: "I couldn't read the screen. Make sure the question is fully visible, then press Assist again.",
      });
    }
    return;
  }

  const packet = state.screenPacket;
  const visible = analysis.questions
    .filter((text) => !isJunkScreenText(text))
    .map((text) => ({
      key: text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180),
      text,
    }));
  const unanswered = (packet?.questions ?? []).filter(
    (item) => !packet?.answered.includes(item.key),
  );
  const toAnswer =
    source === "assist"
      ? visible.length
        ? visible
        : unanswered
      : fresh.filter((item) => !packet?.answered.includes(item.key));

  if (looksLikeCompleteCodingProblem(analysis) && toAnswer.length === 0) {
    const language = analysis.language ? `Language: ${analysis.language}.` : "";
    const signature = analysis.signature ? `Starter: ${analysis.signature}` : "";
    const body = (analysis.problem || analysis.ocrText || "").slice(0, 1600);
    await streamCueCard(
      sessionId,
      {
        kind: "coding",
        text: ["Solve only the interview problem in the attached screenshot.", language, signature, body]
          .filter(Boolean)
          .join("\n"),
      },
      emit,
      extras,
      source,
      true,
      { imageBase64: image, mimeType, groundToScreen: true },
    );
    return;
  }

  if (toAnswer.length === 0) {
    const body = [analysis.problem, analysis.ocrText, analysis.passage]
      .map((item) => (item || "").trim())
      .find((item) => item.length >= 20 && !isJunkScreenText(item)) || "";
    if (body.length >= 20) {
      const algo = looksLikeAlgoProblem(body) || analysis.kind === "code";
      await streamCueCard(
        sessionId,
        {
          kind: algo ? "coding" : analysis.kind === "code" ? "coding" : "technical",
          text: [
            "Answer the interview or coding problem visible on the attached screenshot. Ignore Cursor, this HUD, and any IDE chat.",
            analysis.language ? `Language: ${analysis.language}.` : "",
            body.slice(0, 2400),
          ]
            .filter(Boolean)
            .join("\n"),
        },
        emit,
        extras,
        source,
        true,
        {
          imageBase64: image,
          mimeType,
          groundToScreen: true,
        },
      );
      return;
    }
    if (source === "assist") {
      await emit({
        type: "session.error",
        code: "no_prompt",
        message: "I couldn't read a question on the screen. Make sure it is fully visible, then press Assist again.",
      });
    }
    return;
  }

  const question = formatPacketPrompt(packet ?? { title: "", language: "", passage: "", questions: toAnswer, answered: [] }, toAnswer, {
    imageHasQuestions: analysis.questions.length > 0,
  });
  if (state.screenPacket) {
    state.screenPacket = markAnswered(
      state.screenPacket,
      toAnswer.map((item) => item.key),
    );
  }

  const extract = [analysis.problem, analysis.ocrText, analysis.passage, ...toAnswer.map((item) => item.text)].join("\n");
  const algo = looksLikeAlgoProblem(extract) || analysis.kind === "code";
  await streamCueCard(
    sessionId,
    {
      kind: algo ? "coding" : analysis.kind === "docs" || analysis.kind === "slide" ? "technical" : "coding",
      text: question,
    },
    emit,
    extras,
    source,
    true,
    {
      imageBase64: image,
      mimeType,
      groundToScreen: true,
      maxTokens: algo ? undefined : Math.min(900, 420 + toAnswer.length * 180),
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

function latestFallback(sessionId: string) {
  const state = mem(sessionId);
  return (
    state.pendingTurn ||
    state.recent.slice(-3).join(" ") ||
    state.turns[state.turns.length - 1]?.question ||
    ""
  );
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
      message: "Subscribe on the Plan page, or add your model key there.",
    });
    return;
  }

  const packed = (input.transcript ?? "").trim();
  const latestImage =
    input.images?.[input.images.length - 1]?.imageBase64 ||
    input.imageBase64 ||
    state.pendingScreen?.imageBase64;
  const latestMime =
    input.images?.[input.images.length - 1]?.mimeType ||
    input.mimeType ||
    state.pendingScreen?.mimeType;

  const typed = input.text ? sanitizeText(input.text, { max: LIMITS.question }) : "";
  const conversation = packed || state.recent.slice(-8).join(" ").trim();
  const solveScreen = input.action === "screen" || (input.action === "assist" && !typed && Boolean(latestImage));
  if (solveScreen) {
    if (!latestImage) {
      await emit({
        type: "session.error",
        code: "no_prompt",
        message: "Could not capture the screen. Enable Screen Recording and try again.",
      });
      return;
    }
    await solveFromScreenshot(
      sessionId,
      latestImage,
      latestMime,
      emit,
      extras,
      "assist",
      conversation,
    );
    return;
  }

  const built = assistPrompt(input.action, typed, conversation || latestFallback(sessionId));
  if ("error" in built) {
    await emit({
      type: "session.error",
      code: "no_prompt",
      message: built.error,
    });
    return;
  }

  const useScreen = input.action !== "ask" && Boolean(latestImage);
  const question = conversation && conversation !== built.text
    ? `${built.text}\n\nRecent conversation (oldest first):\n${conversation.slice(-2400)}`
    : built.text;

  const previousKind = state.turns.at(-1)?.kind;
  const specialist =
    built.action === "assist" || built.action === "ask"
      ? previousKind && isFollowUp(built.text)
        ? resolveSpecialist(previousKind)
        : routeQuestion(built.text, state.track, undefined, sessionStage(state, built.text))
      : resolveSpecialist(built.kind);

  await streamCueCard(
    sessionId,
    { kind: specialist.id, text: question },
    emit,
    extras,
    "assist",
    Boolean(input.smart),
    {
      displayText: built.text,
      ...(useScreen
        ? { imageBase64: latestImage, mimeType: latestMime, groundToScreen: false }
        : {}),
    },
  );
}

/** Clears live memory but keeps the session and the audio connection. */
export function resetLiveContext(sessionId: string) {
  const state = mem(sessionId);
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

