import type { AssistAction, AudioSource } from "@meeting-copilot/types";
import { refersToScreen } from "./actions.js";
import { spokenBody } from "./engine.js";
import { isThinAsk } from "./questions.js";

/** Conversation sent with every answer. Older speech beyond this is covered by the rolling summary. */
export const CONVERSATION_CHARS = 60_000;

/** The parts of a session's memory the conversation log is built from. */
export type ConversationState = {
  startedAt: number;
  transcript: { at: number; text: string; source: AudioSource }[];
  partial: string;
  answeredAt: number;
  turns: { question: string; kind: string; answer: string; at: number }[];
  rollingSummary: string;
};

function stamp(at: number, startedAt: number) {
  const seconds = Math.max(0, Math.round((at - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function speaker(source: AudioSource) {
  // System audio only hears the other side of the call; the mic hears both voices mixed.
  return source === "mic" ? "Call audio (both voices)" : "Them";
}

export type Conversation = {
  /** The whole conversation as a dated log, with earlier answers in place. */
  log: string;
  /** Everything said since the last answer, which is what Assist should answer. */
  fresh: string;
};

/**
 * The full conversation, oldest first, with our earlier answers where they happened and a
 * marker where the unanswered part begins. Falls back to the transcript the HUD sent when
 * this session has no server-side speech (typed-only use, or listening off).
 */
export function buildConversation(state: ConversationState, clientTranscript = ""): Conversation {
  const segments = state.transcript;
  const partial = state.partial.trim();
  if (!segments.length && !partial) {
    const sent = clientTranscript.trim();
    const answers = state.turns
      .map((turn) => `You were shown (answer to "${turn.question.slice(0, 200)}"): ${spokenBody(turn.answer).slice(0, 2_000)}`)
      .join("\n");
    return {
      log: [answers, sent ? `Them (recent): ${sent}` : ""].filter(Boolean).join("\n\n"),
      fresh: sent && !state.turns.some((turn) => turn.question === sent) ? sent : "",
    };
  }

  type Line = { at: number; text: string };
  const lines: Line[] = [];
  // Before the first answer everything is new, so no marker is needed.
  let markerPlaced = state.answeredAt === 0;
  const fresh: string[] = [];
  let last: { source: AudioSource; line: Line } | null = null;
  const turns = [...state.turns].sort((a, b) => a.at - b.at);
  let turnIndex = 0;

  const flushTurnsBefore = (at: number) => {
    while (turnIndex < turns.length && turns[turnIndex].at <= at) {
      const turn = turns[turnIndex];
      lines.push({
        at: turn.at,
        text: `[${stamp(turn.at, state.startedAt)}] You were shown (answer to "${turn.question.slice(0, 200)}"): ${spokenBody(turn.answer).slice(0, 2_000)}`,
      });
      turnIndex += 1;
      last = null;
    }
  };

  for (const seg of segments) {
    flushTurnsBefore(seg.at);
    const isFresh = seg.at > state.answeredAt;
    if (isFresh) {
      fresh.push(seg.text);
      if (!markerPlaced) {
        lines.push({ at: seg.at, text: "--- Everything below is new since your last answer ---" });
        markerPlaced = true;
        last = null;
      }
    }
    if (last && last.source === seg.source && seg.at - last.line.at < 4_000) {
      last.line.text = `${last.line.text} ${seg.text}`;
      last.line.at = seg.at;
      continue;
    }
    const line = { at: seg.at, text: `[${stamp(seg.at, state.startedAt)}] ${speaker(seg.source)}: ${seg.text}` };
    lines.push(line);
    last = { source: seg.source, line };
  }
  flushTurnsBefore(Number.POSITIVE_INFINITY);
  if (partial) {
    if (!markerPlaced) lines.push({ at: Date.now(), text: "--- Everything below is new since your last answer ---" });
    lines.push({ at: Date.now(), text: `[now] Them (still being transcribed): ${partial}` });
    fresh.push(partial);
  }

  let log = lines.map((line) => line.text).join("\n");
  if (log.length > CONVERSATION_CHARS) {
    const cut = log.slice(-CONVERSATION_CHARS);
    const tail = cut.slice(cut.indexOf("\n") + 1);
    log = `${state.rollingSummary ? `Earlier in this conversation (summary):\n${state.rollingSummary}\n\n` : ""}(Earlier lines trimmed.)\n${tail}`;
  }
  return { log, fresh: fresh.join(" ").trim() };
}

/** What one Assist press should answer, in priority order. */
export type AssistTarget =
  | { mode: "button"; action: Exclude<AssistAction, "assist" | "ask" | "screen"> }
  | { mode: "screen"; typed: string }
  | { mode: "typed"; typed: string }
  | { mode: "conversation"; said: string }
  | { mode: "continue" }
  | { mode: "none"; message: string };

/**
 * Priority: an explicit screen request, then what they typed, then whatever was said since the
 * last answer, then the screen, then going deeper on the last answer. Speech beats the screen,
 * so a question asked out loud is never swapped for whatever happens to be on the display.
 */
export function pickAssistTarget(input: {
  action: AssistAction;
  typed: string;
  sentImage: boolean;
  anyImage: boolean;
  freshSpeech: string;
  hasTurns: boolean;
}): AssistTarget {
  const { action, typed } = input;
  if (action === "say_next" || action === "follow_up" || action === "fact_check" || action === "recap") {
    return { mode: "button", action };
  }
  if (action === "screen") {
    return input.anyImage
      ? { mode: "screen", typed }
      : { mode: "none", message: "Could not capture the screen. Enable Screen Recording and try again." };
  }
  if (typed) {
    if (input.sentImage && refersToScreen(typed)) return { mode: "screen", typed };
    return { mode: "typed", typed };
  }
  if (action === "ask") return { mode: "none", message: "Type a question first, or wait for them to ask one." };
  const said = input.freshSpeech.trim();
  if (said && !isThinAsk(said)) return { mode: "conversation", said };
  if (input.anyImage) return { mode: "screen", typed: "" };
  if (input.hasTurns) return { mode: "continue" };
  return { mode: "none", message: "Nothing to answer yet. Wait for a question, or type one." };
}
