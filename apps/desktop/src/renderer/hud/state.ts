import type { CaptureHandle, CaptureSource } from "../audio/capture";
import type { InterviewStageId, InterviewTrackId, ListenMode } from "@meeting-copilot/types";
import { DEFAULT_SHORTCUTS, type ShortcutId } from "../../settings";

export type Turn = {
  id: string;
  kind: string;
  question: string;
  transcript: string;
  answer: string;
  done: boolean;
};

export const state = {
  capture: null as CaptureHandle | null,
  audioSource: "system" as CaptureSource,
  listenMode: "auto" as ListenMode,
  listenArmed: false,
  viewIndex: -1,
  socket: null as WebSocket | null,
  watchingScreen: false,
  collapsed: false,
  skipped: 0,
  emitted: 0,
  token: "",
  sessionId: "",
  pendingPdf: null as { name: string; data: string } | null,
  jobTitle: "",
  jobCompany: "",
  jobRequirements: "",
  currentQuestionId: "",
  questionTranscript: "",
  meetingTimer: 0,
  lastMeetingApp: "",
  smartMode: false,
  track: "auto" as InterviewTrackId,
  stage: "auto" as InterviewStageId,
  inferredStage: "auto" as InterviewStageId,
  opacity: 55,
  solidOnHover: true,
  shareVisible: false,
  shortcuts: { ...DEFAULT_SHORTCUTS } as Record<ShortcutId, string>,
  sessionStartedAt: 0,
  clock: 0,
  turns: [] as Turn[],
  busy: false,
};

export function viewingLive() {
  return state.viewIndex < 0 || state.viewIndex === state.turns.length - 1;
}

export function liveTurn() {
  return state.turns[state.turns.length - 1];
}

export function loadAppearance() {
  try {
    const raw = localStorage.getItem("copilot.look");
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      opacity?: number;
      solidOnHover?: boolean;
      shareVisible?: boolean;
    };
    if (typeof parsed.opacity === "number") state.opacity = parsed.opacity;
    if (typeof parsed.solidOnHover === "boolean") state.solidOnHover = parsed.solidOnHover;
    if (typeof parsed.shareVisible === "boolean") state.shareVisible = parsed.shareVisible;
  } catch {
    /* keep defaults */
  }
}

export function saveAppearance() {
  localStorage.setItem(
    "copilot.look",
    JSON.stringify({
      opacity: state.opacity,
      solidOnHover: state.solidOnHover,
      shareVisible: state.shareVisible,
    }),
  );
  void window.copilot?.saveSettings({
    look: {
      opacity: state.opacity,
      solidOnHover: state.solidOnHover,
      shareVisible: state.shareVisible,
    },
  });
}
