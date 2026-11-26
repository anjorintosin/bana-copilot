import type { AssistAction, ClientEvent } from "@meeting-copilot/types";
import { $ } from "./dom";
import {
  applyCollapsed,
  applyInferredStage,
  applySessionClock,
  liveTurn,
  paintStages,
  paintThread,
  prettyKind,
  renderTurn,
  resetCard,
  setAnswer,
  setBusy,
  setDot,
  setPending,
  flashHud,
  hideAnswerLoader,
  renameQuestion,
  flagAnswer,
  showQuestion,
  startSessionClock,
  stopSessionClock,
  syncListenUi,
  viewingLive,
} from "./render";
import { state } from "./state";
import { clearAssistBuffer, pushTranscript } from "./assistBuffer";
import { stopScreenStream } from "./screenStream";

export type SocketHooks = {
  startMeetingWatch: () => void;
  stopMeetingWatch: () => void;
  refreshHistory: () => void;
  openHistoryAfterEnd: (endedId: string) => void;
  startListeningCapture: () => Promise<void>;
  stopListeningCapture: () => void;
  rearmListen: () => void;
  watchAndSolveScreen: () => Promise<void>;
};

export function send(event: ClientEvent | Record<string, unknown>) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(event));
  }
}

export function sendPcm(frame: ArrayBuffer) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(frame);
}

export function sendConfig() {
  send({
    type: "session.config",
    sessionId: state.sessionId || undefined,
    track: state.track,
    stage: state.stage,
    listenMode: state.listenMode,
    modeId: state.activeModeId || undefined,
  });
}

export function sendAssist(
  action: AssistAction,
  text?: string,
  extras?: {
    jpegBase64?: string;
    transcript?: string;
    images?: { imageBase64: string; mimeType?: string }[];
  },
) {
  send({
    type: "assist.request",
    sessionId: state.sessionId || undefined,
    action,
    text: text?.trim() || undefined,
    transcript: extras?.transcript,
    imageBase64: extras?.jpegBase64,
    images: extras?.images?.length ? extras.images : undefined,
    mimeType: extras?.jpegBase64 || extras?.images?.length ? "image/jpeg" : undefined,
    smart: state.smartMode,
  });
}

export function connectGateway(hooks: SocketHooks) {
  const base = window.copilot?.apiUrl ?? "ws://127.0.0.1:8787/ws";
  const url = state.token
    ? `${base}?token=${encodeURIComponent(state.token)}`
    : base;
  $.wsStatus.textContent = "Connecting gateway…";
  state.socket = new WebSocket(url);
  state.socket.binaryType = "arraybuffer";

  state.socket.addEventListener("open", () => {
    $.wsStatus.textContent = "Gateway connected";
    setDot("ok");
    send({ type: "ping", timestamp: Date.now() });
    hooks.rearmListen();
  });

  state.socket.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "hello") $.liveText.textContent = msg.message;
      if (msg.type === "turn.pending") {
        const live = liveTurn();
        if (live?.done || live?.answer) {
          // Keep the current card still while you talk it through.
          return;
        }
        const snippet = String(msg.text).slice(0, 72);
        setPending(`They're still talking… ${snippet}`);
        $.liveText.textContent = `They're still talking… ${snippet}`;
      }
      if (msg.type === "listen.state") {
        if (msg.active) {
          state.listenArmed = true;
          $.liveText.textContent = "Live transcription on";
        } else if (state.capture && state.listenMode === "auto") {
          hooks.rearmListen();
        } else {
          state.listenArmed = false;
        }
        syncListenUi();
      }
      if (msg.type === "transcript.final" || msg.type === "transcript.interpreted") {
        if (msg.type === "transcript.final") {
          $.liveText.textContent = `Heard: ${String(msg.text).slice(0, 80)}`;
          pushTranscript(String(msg.text ?? ""));
        }
        const turn = state.currentQuestionId
          ? state.turns.find((item) => item.id === state.currentQuestionId) ??
            liveTurn()
          : undefined;
        if (msg.type === "transcript.interpreted") {
          if (turn) {
            turn.transcript = msg.text;
            state.questionTranscript = msg.text;
          }
        } else if (turn) {
          turn.transcript = `${turn.transcript} ${msg.text}`.trim();
          state.questionTranscript = turn.transcript;
        }
      }
      if (msg.type === "session.stage") {
        applyInferredStage(msg.stage);
      }
      if (msg.type === "intent.held") {
        $.liveText.textContent =
          msg.intent === "hint"
            ? "They're hinting — stay on this card"
            : "They're probing — stay on this answer";
      }
      if (msg.type === "question.detected") {
        showQuestion(msg.questionId, msg.kind, msg.text);
        $.liveText.textContent = `Question (${msg.agent || prettyKind(msg.kind)})`;
      }
      if (msg.type === "question.updated") {
        renameQuestion(msg.questionId, msg.text);
      }
      if (msg.type === "answer.flag") {
        flagAnswer(msg.questionId, {
          kind: msg.kind,
          sentence: typeof msg.sentence === "string" ? msg.sentence : undefined,
          replacement: typeof msg.replacement === "string" ? msg.replacement : undefined,
        });
      }
      if (msg.type === "answer.started") {
        const turn = state.turns.find((item) => item.id === msg.questionId);
        if (turn) {
          turn.answer = "";
          if (!turn.screenshot && state.pendingScreenshot) {
            turn.screenshot = state.pendingScreenshot;
            state.pendingScreenshot = undefined;
            paintThread();
          }
        }
        if (!state.busy) setBusy(true, "Thinking…");
        if (viewingLive()) setAnswer("", true);
      }
      if (msg.type === "answer.delta") {
        const turn =
          state.turns.find((item) => item.id === msg.questionId) ?? liveTurn();
        if (turn) turn.answer += msg.text;
        hideAnswerLoader();
        if (
          viewingLive() &&
          (!msg.questionId || state.turns[state.viewIndex]?.id === msg.questionId)
        ) {
          setAnswer(turn?.answer ?? "", false);
        }
      }
      if (msg.type === "answer.completed") {
        const turn =
          state.turns.find((item) => item.id === msg.questionId) ?? liveTurn();
        if (turn) {
          turn.done = true;
          if (typeof msg.text === "string" && msg.text) turn.answer = msg.text;
        }
        setBusy(false);
        if (viewingLive() && turn?.answer) setAnswer(turn.answer, false);
        $.liveText.textContent = "Answer complete";
      }
      if (msg.type === "summary.rolling") {
        $.liveText.textContent = "Memory updated";
      }
      if (msg.type === "session.summary") {
        $.liveText.textContent = "Recap saved";
        hooks.refreshHistory();
      }
      if (msg.type === "screen.insight") {
        const label = msg.title ? `Screen: ${msg.title}` : "Screen updated";
        $.liveText.textContent = label;
        $.screenStatus.textContent = label;
      }
      if (msg.type === "session.ready") {
        state.sessionId = msg.sessionId;
        $.sessionStatus.textContent = `Active ${state.sessionId.slice(0, 8)}… — transcript and answers save to Postgres`;
        startSessionClock();
        hooks.startMeetingWatch();
        sendConfig();
        void window.copilot?.setSessionActive(true);
        if (!state.capture) void hooks.startListeningCapture();
        void hooks.watchAndSolveScreen();
      }
      if (msg.type === "session.ended") {
        const endedId = state.sessionId;
        void window.copilot?.setSessionActive(false);
        if (state.capture) hooks.stopListeningCapture();
        if (state.watchingScreen) {
          void window.copilot?.stopScreen();
          state.watchingScreen = false;
        }
        stopScreenStream();
        state.sessionId = "";
        $.sessionStatus.textContent = "Session ended and saved.";
        applySessionClock();
        hooks.stopMeetingWatch();
        stopSessionClock();
        setBusy(false);
        clearAssistBuffer();
        hooks.openHistoryAfterEnd(endedId);
      }
      if (msg.type === "context.cleared") {
        setBusy(false);
        state.inferredStage = "auto";
        paintStages();
        clearAssistBuffer();
        applyCollapsed(true);
        void window.copilot?.setCollapsed(true);
        resetCard("Context cleared.", "Ask again, or wait for the next question.");
        $.liveText.textContent = "Context cleared.";
      }
      if (msg.type === "session.saved") {
        $.liveText.textContent = `Saved ${msg.kind}`;
      }
      if (msg.type === "session.error") {
        $.sessionStatus.textContent = msg.message;
        $.liveText.textContent = msg.message;
        if (msg.code === "stt_fallback" || msg.code === "stt_network") {
          /* keep listening */
        } else if (msg.code === "need_stt") {
          flashHud(String(msg.message));
        } else {
          setBusy(false);
          setAnswer(String(msg.message), true);
          if (state.collapsed) flashHud(String(msg.message));
        }
      }
      if (msg.type === "answer.cancelled") {
        // A newer question replaced this answer, so stay busy: the newer answer is on its way.
        // Drop the card if nothing was written yet.
        const index = state.turns.findIndex((item) => item.id === msg.questionId);
        const turn = state.turns[index];
        if (turn) {
          turn.done = true;
          if (!turn.answer.trim()) {
            state.turns.splice(index, 1);
            if (state.viewIndex >= state.turns.length) state.viewIndex = state.turns.length - 1;
          }
          paintThread();
        }
      }
    } catch {
      /* ignore */
    }
  });

  state.socket.addEventListener("close", () => {
    $.wsStatus.textContent = "Gateway offline — waiting for the API…";
    setDot("bad");
    setTimeout(async () => {
      if (!state.token) {
        try {
          const auth = await window.copilot.ensureAuth();
          state.token = auth.token;
          $.sessionStatus.textContent = `Signed in as device ${auth.userId.slice(0, 8)}…`;
        } catch {
          /* API still down */
        }
      }
      connectGateway(hooks);
    }, 1500);
  });

  state.socket.addEventListener("error", () => {
    $.wsStatus.textContent = "Gateway error";
    setDot("bad");
  });
}
