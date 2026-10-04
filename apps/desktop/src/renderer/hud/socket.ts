import type { AssistAction, ClientEvent } from "@meeting-copilot/types";
import { $ } from "./dom";
import {
  applyInferredStage,
  applySessionClock,
  liveTurn,
  paintStages,
  prettyKind,
  renderTurn,
  resetCard,
  setAnswer,
  setDot,
  setPending,
  showQuestion,
  showRecap,
  startSessionClock,
  stopSessionClock,
  syncListenUi,
  viewingLive,
} from "./render";
import { state } from "./state";

export type SocketHooks = {
  startMeetingWatch: () => void;
  stopMeetingWatch: () => void;
  refreshHistory: () => void;
  startListeningCapture: () => Promise<void>;
  stopListeningCapture: () => void;
  rearmListen: () => void;
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
  if (!state.sessionId) return;
  send({
    type: "session.config",
    sessionId: state.sessionId,
    track: state.track,
    stage: state.stage,
    listenMode: state.listenMode,
  });
}

export function sendAssist(
  action: AssistAction,
  text?: string,
  shot?: { jpegBase64: string },
) {
  send({
    type: "assist.request",
    sessionId: state.sessionId,
    action,
    text: text?.trim() || undefined,
    imageBase64: shot?.jpegBase64,
    mimeType: shot ? "image/jpeg" : undefined,
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
            : "They're probing — use If they push";
      }
      if (msg.type === "question.detected") {
        showQuestion(msg.questionId, msg.kind, msg.text);
        $.liveText.textContent = `Question (${msg.agent || prettyKind(msg.kind)})`;
      }
      if (msg.type === "answer.started") {
        const turn = state.turns.find((item) => item.id === msg.questionId);
        if (turn) turn.answer = "";
        if (viewingLive()) setAnswer("Thinking…", true);
      }
      if (msg.type === "answer.delta") {
        const turn =
          state.turns.find((item) => item.id === msg.questionId) ?? liveTurn();
        if (turn) turn.answer += msg.text;
        if (
          viewingLive() &&
          (!msg.questionId || state.turns[state.viewIndex]?.id === msg.questionId)
        ) {
          setAnswer(turn?.answer ?? "", false);
          $.answer.scrollTop = $.answer.scrollHeight;
        }
      }
      if (msg.type === "answer.completed") {
        const turn =
          state.turns.find((item) => item.id === msg.questionId) ?? liveTurn();
        if (turn) {
          turn.done = true;
          if (typeof msg.text === "string" && msg.text) turn.answer = msg.text;
        }
        if (viewingLive()) renderTurn(state.viewIndex);
        $.liveText.textContent = "Answer complete";
      }
      if (msg.type === "summary.rolling") {
        $.liveText.textContent = "Memory updated";
      }
      if (msg.type === "session.summary") {
        showRecap(msg.text);
        $.liveText.textContent = "Recap saved";
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
        if (!state.capture) {
          void hooks.startListeningCapture();
        }
      }
      if (msg.type === "session.ended") {
        void window.copilot?.setSessionActive(false);
        if (state.capture) hooks.stopListeningCapture();
        state.sessionId = "";
        $.sessionStatus.textContent = "Session ended and saved.";
        applySessionClock();
        hooks.stopMeetingWatch();
        stopSessionClock();
        hooks.refreshHistory();
      }
      if (msg.type === "context.cleared") {
        state.inferredStage = "auto";
        paintStages();
        resetCard("Context cleared.", "Ask again, or wait for the next question.");
        $.liveText.textContent = "Context cleared.";
      }
      if (msg.type === "session.saved") {
        $.liveText.textContent = `Saved ${msg.kind}`;
      }
      if (msg.type === "session.error") {
        $.sessionStatus.textContent = msg.message;
        $.liveText.textContent = msg.message;
        if (msg.code !== "stt_fallback" && msg.code !== "stt_network") {
          setAnswer(String(msg.message), true);
        }
      }
      if (msg.type === "answer.cancelled") {
        $.liveText.textContent = "Answer cancelled";
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
