import {
  INTERVIEW_STAGES,
  type AssistAction,
  type InterviewStageId,
  type InterviewTrackId,
} from "@meeting-copilot/types";
import { defaultAudioSource, markHostPlatform, mediaIsBlocked } from "../compat";
import { formatAccelerator, type AppSettings } from "../settings";
import { startCapture, type CaptureSource } from "./audio/capture";
import "./hud/bridge";
import { $ } from "./hud/dom";
import {
  applyAppearance,
  applyCollapsed,
  applySessionClock,
  applyShortcutLabels,
  bindThreadScroll,
  closePopovers,
  hideHudPops,
  hideHudTip,
  makeCopyBtn,
  paintStages,
  persistLook,
  renderTurn,
  resetCard,
  setBusy,
  setChip,
  setTip,
  showHudTip,
  syncListenUi,
} from "./hud/render";
import { connectGateway, send, sendAssist, sendConfig, sendPcm } from "./hud/socket";
import { loadAppearance, state } from "./hud/state";
import { answerPlainText } from "./hud/answer";
import {
  asksAboutScreen,
  clearAssistBuffer,
  markAssistAnswered,
  pushScreenFrame,
  sliceAssistWindow,
} from "./hud/assistBuffer";
import { ensureScreenStream, grabStreamShot, stopScreenStream } from "./hud/screenStream";

function grabShot() {
  return window.copilot.screenMode === "stream" ? grabStreamShot() : window.copilot.grabShot();
}

function listenChord() {
  return formatAccelerator(state.shortcuts.listen, window.copilot?.platform ?? "darwin");
}

function applySettings(next: AppSettings) {
  state.shortcuts = next.shortcuts;
  state.opacity = next.look.opacity;
  state.solidOnHover = next.look.solidOnHover;
  state.shareVisible = next.look.shareVisible;
  applyAppearance();
  applyShortcutLabels();
  syncListenUi();
}

function fillStages() {
  paintStages();
}

async function ensureSession() {
  if (state.sessionId) return true;
  send({
    type: "meeting.started",
    jobContext: {
      title: state.jobTitle || undefined,
      company: state.jobCompany || undefined,
      requirements: state.jobRequirements || undefined,
    },
    track: state.track,
    stage: state.stage,
    listenMode: state.listenMode,
  });
  const started = Date.now();
  while (!state.sessionId && Date.now() - started < 8000) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return Boolean(state.sessionId);
}

function armServerListen() {
  if (!state.sessionId) return;
  send({
    type: "listen.start",
    sessionId: state.sessionId,
    source: state.audioSource,
    track: state.track,
    stage: state.stage,
  });
}

function rearmListen() {
  if (!state.sessionId || !state.capture) return;
  if (state.listenMode === "auto" && !state.capture.getSending()) return;
  if (state.listenMode === "shortcut" && !state.listenArmed) return;
  armServerListen();
  $.liveText.textContent = "Listening…";
}

let listenStarting = false;
let silentForMs = 0;

async function startListeningCapture() {
  if (state.capture || listenStarting) return;
  listenStarting = true;
  silentForMs = 0;
  $.micStatus.textContent = "Starting session…";
  try {
    const ready = await ensureSession();
    if (!ready) {
      $.micStatus.textContent =
        "No session — gateway offline. Wait for “Gateway connected”, then try again.";
      return;
    }

    if (state.audioSource === "mic") {
      const perm = await window.copilot.requestMic();
      if (mediaIsBlocked(perm.status)) {
        $.micStatus.textContent = `Microphone is off. Allow it in ${perm.listName} settings.`;
        return;
      }
    }

    const captureOpts = {
      onFrame: (pcm: ArrayBuffer) => sendPcm(pcm),
      onLevel: (rms: number) => {
        $.meterFill.style.width = `${Math.min(100, Math.round(rms * 400))}%`;
        if (rms >= 0.012) {
          silentForMs = 0;
          return;
        }
        silentForMs += 100;
        if (silentForMs === 4000) {
          $.liveText.textContent =
            state.audioSource === "system"
              ? "Listen is on, but no meeting audio yet. Check System Audio Recording, or switch to My mic."
              : "Listen is on, but the mic is silent.";
        }
      },
    };
    try {
      state.capture = await startCapture({ source: state.audioSource, ...captureOpts });
    } catch (err) {
      if (state.audioSource !== "system") throw err;
      const perm = await window.copilot.requestMic();
      if (mediaIsBlocked(perm.status)) throw err;
      state.capture = await startCapture({ source: "mic", ...captureOpts });
      state.audioSource = "mic";
      setChip($.sourceMic, $.sourceSystem);
      $.micStatus.textContent = "Their audio isn't available on this computer, so Listen is using your mic.";
    }

    if (state.listenMode === "shortcut") {
      state.capture.setSending(false);
      state.listenArmed = false;
      $.liveText.textContent = `Press ${listenChord()} to capture a question.`;
    } else {
      state.capture.setSending(true);
      state.listenArmed = true;
      armServerListen();
      $.liveText.textContent = "Listening for interviewer questions…";
    }
    syncListenUi();
  } catch (err) {
    state.capture?.stop();
    state.capture = null;
    $.micStatus.textContent =
      err instanceof Error
        ? err.message
        : "Could not start listening. Try My mic, or grant System Audio Recording.";
  } finally {
    listenStarting = false;
  }
}

function stopListeningCapture() {
  if (state.sessionId) send({ type: "listen.stop", sessionId: state.sessionId });
  state.capture?.stop();
  state.capture = null;
  state.listenArmed = false;
  syncListenUi();
  $.liveText.textContent = "Listening stopped.";
}

async function toggleListenShortcut() {
  if (!state.capture) {
    try {
      await startListeningCapture();
    } catch (err) {
      $.micStatus.textContent =
        err instanceof Error ? err.message : "Could not start listening.";
      return;
    }
  }
  if (!state.capture || state.listenMode !== "shortcut") return;

  if (!state.capture.getSending()) {
    state.listenArmed = true;
    state.capture.setSending(true);
    armServerListen();
    $.liveText.textContent = `Capturing… press ${listenChord()} again when they finish.`;
    syncListenUi();
    return;
  }

  send({ type: "listen.commit", sessionId: state.sessionId });
  state.capture.setSending(false);
  state.listenArmed = false;
  $.liveText.textContent = `Committed. Press ${listenChord()} for the next question.`;
  syncListenUi();
}

const BUSY_LABEL: Partial<Record<AssistAction, string>> = {
  screen: "Solving what's on screen…",
  say_next: "Writing what to say…",
  follow_up: "Writing follow-ups…",
  fact_check: "Checking that…",
  recap: "Writing recap…",
  assist: "Thinking…",
  ask: "Thinking…",
};

function requestAssist(
  action: AssistAction,
  text?: string,
  extras?: {
    jpegBase64?: string;
    transcript?: string;
    images?: { imageBase64: string; mimeType?: string }[];
  },
) {
  if (state.busy) {
    $.liveText.textContent = "Still working — wait for this answer.";
    return false;
  }
  if (state.socket?.readyState !== WebSocket.OPEN) {
    $.liveText.textContent = "Gateway offline — try again in a moment.";
    return false;
  }
  setBusy(true, BUSY_LABEL[action] ?? "Working on it…");
  $.liveText.textContent = BUSY_LABEL[action] ?? "Working on it…";
  sendAssist(action, text, extras);
  return true;
}

async function watchAndSolveScreen() {
  await ensureScreenWatch();
}

async function requestScreenAssist() {
  if (state.busy) {
    $.liveText.textContent = "Still working — wait for this answer.";
    return;
  }
  setBusy(true, "Solving what's on screen…");
  $.liveText.textContent = "Solving what's on screen…";
  const shot = await grabShot();
  if (!shot.ok || !shot.jpegBase64) {
    setBusy(false);
    $.liveText.textContent =
      shot.error || "Could not capture the screen. Allow Screen Recording, then retry.";
    return;
  }
  state.pendingScreenshot = shot.dataUrl || "";
  if (state.socket?.readyState !== WebSocket.OPEN) {
    setBusy(false);
    $.liveText.textContent = "Gateway offline — try again in a moment.";
    return;
  }
  sendAssist("screen", undefined, {
    jpegBase64: shot.jpegBase64,
    transcript: sliceAssistWindow().transcript,
  });
}

/** The AI may look at the screen when Screen is on, or while a session is listening. */
function screenAllowed() {
  return state.watchingScreen || Boolean(state.sessionId);
}

/**
 * Assist sends what was said (recent transcript) and, when screen access is on, a fresh
 * screenshot. The server answers the newest spoken question with the screen as context,
 * or solves the screen using what was said.
 */
async function triggerAssist() {
  const typed = $.askInput.value.trim();
  const pack = sliceAssistWindow();

  if (typed) {
    $.askInput.value = "";
    const typedShot = screenAllowed() && asksAboutScreen(typed) ? await grabShot() : null;
    const typedImage = typedShot?.ok && typedShot.jpegBase64 ? typedShot.jpegBase64 : undefined;
    if (typedImage && typedShot) {
      state.pendingScreenshot = typedShot.dataUrl || "";
    }
    void requestAssist("ask", typed, { transcript: pack.transcript, jpegBase64: typedImage });
    return;
  }

  const shot = screenAllowed() ? await grabShot() : null;
  const image = shot?.ok && shot.jpegBase64 ? shot.jpegBase64 : undefined;
  if (!image && !pack.question && !pack.transcript) {
    $.askInput.placeholder = screenAllowed()
      ? "No question yet — type one, or allow Screen Recording."
      : "No question yet — type one, or turn on Screen so I can see it.";
    window.setTimeout(() => {
      if ($.askInput.placeholder.startsWith("No question yet")) {
        $.askInput.placeholder = "Ask anything…";
      }
    }, 2800);
    return;
  }
  if (image && shot) {
    state.pendingScreenshot = shot.dataUrl || "";
  }
  const sent = requestAssist("assist", pack.question || undefined, {
    jpegBase64: image,
    transcript: pack.transcript,
  });
  if (sent) markAssistAnswered(pack.to);
}

function clearContext() {
  clearAssistBuffer();
  send({ type: "context.clear", sessionId: state.sessionId || undefined });
  if (!state.sessionId) {
    resetCard("Ask anything, or press Assist.", "Answers show here when you press Enter or Assist.");
  }
}

async function pollMeetingApp() {
  if (!state.sessionId) return;
  try {
    const hit = await window.copilot.detectMeeting();
    $.coach.textContent = hit.coach;
    if (hit.id !== "none" && hit.id !== state.lastMeetingApp) {
      state.lastMeetingApp = hit.id;
      $.liveText.textContent = `${hit.name} detected`;
      send({ type: "meeting.app", sessionId: state.sessionId, app: hit.name });
    }
  } catch {
    /* Screen Recording may be off */
  }
}

function startMeetingWatch() {
  stopMeetingWatch();
  state.lastMeetingApp = "";
  void pollMeetingApp();
  state.meetingTimer = window.setInterval(pollMeetingApp, 8000);
}

function stopMeetingWatch() {
  if (state.meetingTimer) window.clearInterval(state.meetingTimer);
  state.meetingTimer = 0;
}

type SessionRow = {
  id: string;
  status: string;
  started_at: string;
  transcript_count: number;
  summary?: string | null;
  meeting_app?: string | null;
  job_title?: string | null;
  company?: string | null;
};

let pastSessions: SessionRow[] = [];
let endedSessionId = "";

async function refreshHistory() {
  if (!state.token) return;
  try {
    const listed = await window.copilot.listSessions(state.token);
    pastSessions = (listed.sessions ?? []) as SessionRow[];
  } catch {
    pastSessions = [];
  }
  paintHistorySessions();
}

function paintHistorySessions() {
  const earlier = pastSessions.filter((row) => row.id !== state.sessionId);
  if (!earlier.length) {
    const empty = document.createElement("p");
    empty.className = "hist-empty";
    empty.textContent = "No sessions yet.";
    $.historySessions.replaceChildren(empty);
    return;
  }
  $.historySessions.replaceChildren(
    ...earlier.slice(0, 8).map((row) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `hist-item${row.id === endedSessionId ? " just-ended" : ""}`;
      const when = new Date(row.started_at).toLocaleString();
      const role = [row.job_title, row.company].filter(Boolean).join(" · ");
      const title = document.createElement("strong");
      title.textContent = role || row.meeting_app || "Session";
      const hint = document.createElement("span");
      hint.textContent = `${when} · ${row.transcript_count} turn${row.transcript_count === 1 ? "" : "s"}`;
      btn.append(title, hint);
      btn.addEventListener("click", () => {
        hideHudPops();
        void setCollapsed(false);
        pinAndShowPast(row, role);
      });
      return btn;
    }),
  );
}

function pinAndShowPast(row: SessionRow, role: string) {
  const art = document.createElement("article");
  art.className = "msg active";
  const q = document.createElement("p");
  q.className = "msg-meta";
  q.textContent = role || "Earlier session";
  const a = document.createElement("div");
  const summary = row.summary?.trim();
  a.className = `msg-a${summary ? "" : " placeholder"}`;
  a.textContent = summary || "No recap stored for this session.";
  art.append(q, a);
  if (summary) art.append(makeCopyBtn());
  $.thread.replaceChildren(art);
}

async function openHistoryAfterEnd(endedId: string) {
  endedSessionId = endedId;
  resetCard(
    "Ask anything, or press Assist.",
    "Answers show here when you press Enter or Assist.",
  );
  await refreshHistory();
  if (endedId && !pastSessions.some((row) => row.id === endedId)) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    await refreshHistory();
  }
  hideHudPops();
  $.historyPop.hidden = false;
  $.hud.classList.add("history-open");
  $.historyBtn.setAttribute("aria-pressed", "true");
  void setCollapsed(false);
}

async function toggleHistoryPop() {
  const wasOpen = !$.historyPop.hidden;
  hideHudPops();
  void window.copilot?.closeHome();
  if (wasOpen) {
    if (!state.turns.length) void setCollapsed(true);
    return;
  }
  await refreshHistory();
  $.historyPop.hidden = false;
  $.hud.classList.add("history-open");
  $.historyBtn.setAttribute("aria-pressed", "true");
  void setCollapsed(false);
}

async function loadProfile() {
  if (!state.token) return;
  const profile = await window.copilot.getProfile(state.token);
  state.jobTitle = profile.jobTitle ?? "";
  state.jobCompany = profile.company ?? "";
  state.jobRequirements = profile.requirements ?? "";
  if (profile.defaultTrack) {
    state.track = profile.defaultTrack as InterviewTrackId;
  }
  await loadModes();
}

function paintModes() {
  const active = state.modes.find((item) => item.id === state.activeModeId);
  setTip($.modesBtn, active ? `Modes — ${active.name}` : "Modes");
  $.modesGrid.replaceChildren(
    ...state.modes.map((mode) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mode-tile${mode.id === state.activeModeId ? " active" : ""}`;
      const check = document.createElement("span");
      check.className = "mode-check";
      check.textContent = mode.id === state.activeModeId ? "✓" : "";
      const title = document.createElement("strong");
      title.textContent = mode.name;
      btn.append(check, title);
      btn.addEventListener("click", () => {
        void chooseMode(mode.id);
      });
      return btn;
    }),
  );
}

async function loadModes() {
  if (!state.token) return;
  const listed = await window.copilot.listModes(state.token);
  if (listed.error || !listed.modes) return;
  state.modes = listed.modes;
  state.activeModeId = listed.activeModeId;
  paintModes();
}

async function chooseMode(id: string) {
  if (!state.token) return;
  const listed = await window.copilot.selectMode(state.token, id);
  if (listed.error || !listed.modes) return;
  state.modes = listed.modes;
  state.activeModeId = listed.activeModeId;
  paintModes();
  sendConfig();
  closePopovers();
}

function dismissHudModals() {
  closePopovers();
  void window.copilot?.closeHome();
}

function openHudHome(hash: string) {
  closePopovers();
  void window.copilot?.openHome(hash);
}

async function toggleModesPop() {
  const wasOpen = !$.modesPop.hidden;
  hideHudPops();
  void window.copilot?.closeHome();
  if (wasOpen) {
    void window.copilot?.setHudMenu(false);
    return;
  }
  await loadModes();
  $.modesPop.hidden = false;
  $.hud.classList.add("modes-open");
  document.documentElement.classList.add("modes-open");
  $.modesBtn.setAttribute("aria-pressed", "true");
  await window.copilot?.setHudMenu(true);
}

async function setCollapsed(next: boolean) {
  applyCollapsed(next);
  await window.copilot?.setCollapsed(next);
}

$.listenPill.addEventListener("click", async () => {
  dismissHudModals();
  try {
    if (state.sessionId) {
      startOrEndSession();
      return;
    }
    await startListeningCapture();
  } catch (err) {
    state.capture?.stop();
    state.capture = null;
    $.micStatus.textContent =
      err instanceof Error
        ? err.message
        : "Could not start listening. Try My mic, or grant System Audio Recording.";
    console.error(err);
  }
});

$.sourceSystem.addEventListener("click", () => {
  if (state.capture) return;
  state.audioSource = "system" as CaptureSource;
  setChip($.sourceSystem, $.sourceMic);
  syncListenUi();
});

$.sourceMic.addEventListener("click", () => {
  if (state.capture) return;
  state.audioSource = "mic";
  setChip($.sourceMic, $.sourceSystem);
  syncListenUi();
});

$.modeAuto.addEventListener("click", () => {
  state.listenMode = "auto";
  setChip($.modeAuto, $.modeShortcut);
  sendConfig();
  syncListenUi();
});

$.modeShortcut.addEventListener("click", () => {
  state.listenMode = "shortcut";
  setChip($.modeShortcut, $.modeAuto);
  sendConfig();
  syncListenUi();
});

$.stageSelect.addEventListener("change", () => {
  state.stage = $.stageSelect.value as InterviewStageId;
  if (state.stage !== "auto") state.inferredStage = "auto";
  paintStages();
  sendConfig();
  const hit = INTERVIEW_STAGES.find((item) => item.id === state.stage);
  $.liveText.textContent = hit ? `${hit.label} — ${hit.hint}` : "Stage updated.";
});

$.smartBtn.addEventListener("click", () => {
  state.smartMode = !state.smartMode;
  $.smartBtn.setAttribute("aria-pressed", state.smartMode ? "true" : "false");
  $.liveText.textContent = state.smartMode
    ? "Smart Mode on — coding and screen use the stronger model."
    : "Smart Mode off.";
});

function startOrEndSession() {
  if (state.sessionId) {
    $.sessionStatus.textContent = "Ending session…";
    stopListeningCapture();
    send({ type: "meeting.ended", sessionId: state.sessionId });
    return;
  }
  send({
    type: "meeting.started",
    jobContext: {
      title: state.jobTitle || undefined,
      company: state.jobCompany || undefined,
      requirements: state.jobRequirements || undefined,
    },
    track: state.track,
    stage: state.stage,
    listenMode: state.listenMode,
  });
}

$.sessionBtn.addEventListener("click", () => startOrEndSession());
$.launchStart.addEventListener("click", () => startOrEndSession());

$.homeBtn.addEventListener("click", () => {
  openHudHome("#general");
});
document.getElementById("modes-btn")?.addEventListener("click", () => {
  void toggleModesPop();
});
$.modesManage.addEventListener("click", () => {
  openHudHome("#modes");
});
document.getElementById("history-btn")?.addEventListener("click", () => {
  void toggleHistoryPop();
});
$.shortcutsBtn.addEventListener("click", () => {
  openHudHome("#shortcuts");
});
$.collapseBtn.addEventListener("click", () => {
  void setCollapsed(!state.collapsed);
});
$.backBtn.addEventListener("click", () => {
  if (state.collapsed) return;
  hideHudPops();
  void setCollapsed(true);
});
$.hideBtn.addEventListener("click", () => {
  void window.copilot?.hideHud();
});

$.opacitySlider.addEventListener("input", () => {
  state.opacity = Number($.opacitySlider.value);
  persistLook();
});

$.solidHover.addEventListener("change", () => {
  state.solidOnHover = $.solidHover.checked;
  persistLook();
});

function toggleShareVisibility() {
  state.shareVisible = !state.shareVisible;
  persistLook();
  $.liveText.textContent = state.shareVisible
    ? "HUD visible on screen share — they can see it."
    : "HUD hidden from screen share.";
}

$.shareBtn.addEventListener("click", () => {
  dismissHudModals();
  toggleShareVisibility();
});

$.shareVisible.addEventListener("change", () => {
  state.shareVisible = $.shareVisible.checked;
  persistLook();
  $.liveText.textContent = state.shareVisible
    ? "HUD visible on screen share — they can see it."
    : "HUD hidden from screen share.";
});

$.actions.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest("button[data-action]");
  if (!(btn instanceof HTMLButtonElement)) return;
  const action = btn.dataset.action;
  if (action === "screen") {
    void requestScreenAssist();
    return;
  }
  if (
    action === "say_next" ||
    action === "follow_up" ||
    action === "fact_check" ||
    action === "recap"
  ) {
    void requestAssist(action);
  }
});

function bindHudDrag(root: HTMLElement) {
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let didDrag = false;
  let active = false;

  const onMove = (event: PointerEvent) => {
    if (!active) return;
    const dx = event.screenX - lastX;
    const dy = event.screenY - lastY;
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    dragging = true;
    didDrag = true;
    if (!root.hasPointerCapture(event.pointerId)) {
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        /* already captured or released */
      }
    }
    window.copilot?.moveHudBy(dx, dy);
    lastX = event.screenX;
    lastY = event.screenY;
  };

  const onUp = () => {
    active = false;
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select")) return;
    active = true;
    dragging = false;
    didDrag = false;
    lastX = event.screenX;
    lastY = event.screenY;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  root.addEventListener(
    "click",
    (event) => {
      if (!didDrag) return;
      didDrag = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

bindHudDrag($.hud);

function setGhostChip(_passThrough: boolean) {
  $.ghostChip.hidden = true;
}

for (const field of [$.askInput, $.stageSelect]) {
  field.addEventListener("pointerdown", () => {
    if (state.sessionId) return;
    void window.copilot?.setFocusable(true);
  });
  field.addEventListener("blur", () => {
    void window.copilot?.setFocusable(false);
  });
}

$.askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  dismissHudModals();
  triggerAssist();
});

$.thread.addEventListener("click", async (event) => {
  const msgCopy = (event.target as HTMLElement).closest(".msg-copy");
  if (msgCopy instanceof HTMLButtonElement) {
    const turnId = (msgCopy.closest(".msg") as HTMLElement | null)?.dataset.turn;
    const answer = state.turns.find((turn) => turn.id === turnId)?.answer ?? "";
    const text = answerPlainText(answer);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      msgCopy.classList.add("copied");
      msgCopy.dataset.tip = "Copied";
      setTimeout(() => {
        msgCopy.classList.remove("copied");
        msgCopy.dataset.tip = "Copy";
      }, 1200);
    } catch {
      msgCopy.dataset.tip = "Copy failed";
    }
    return;
  }
  const btn = (event.target as HTMLElement).closest(".copy-btn");
  if (!(btn instanceof HTMLButtonElement)) return;
  const block = btn.closest(".code-block");
  const code = block?.querySelector("code")?.textContent ?? "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = "Copy";
    }, 1200);
  } catch {
    btn.textContent = "Copy failed";
  }
});

$.prevBtn.addEventListener("click", () => {
  if (state.viewIndex > 0) renderTurn(state.viewIndex - 1);
});

$.nextBtn.addEventListener("click", () => {
  if (state.viewIndex < state.turns.length - 1) renderTurn(state.viewIndex + 1);
});

$.micPrefsBtn.addEventListener("click", () => window.copilot.openMicSettings());
$.screenSettingsBtn.addEventListener("click", () =>
  window.copilot.openScreenSettings(),
);

async function ensureScreenWatch() {
  if (state.watchingScreen) return true;
  const result = await window.copilot.startScreen();
  if (!result.ok) {
    $.screenStatus.textContent = `Screen Recording is off. Allow it for ${result.listName}, then retry.`;
    return false;
  }
  if (window.copilot.screenMode === "stream" && !(await ensureScreenStream())) {
    $.screenStatus.textContent = "Screen sharing was cancelled. Turn Screen on again and pick a screen.";
    return false;
  }
  state.watchingScreen = true;
  state.skipped = 0;
  state.emitted = 0;
  $.screenBtn.setAttribute("aria-pressed", "true");
  setTip($.screenBtn, `Screen — watching`);
  $.screenStatus.textContent = "Watching the screen. Assist uses it when the question is about what's on screen.";
  return true;
}

$.screenBtn.addEventListener("click", async () => {
  dismissHudModals();
  if (state.watchingScreen) {
    await window.copilot.stopScreen();
    stopScreenStream();
    state.watchingScreen = false;
    $.screenPreview.hidden = true;
    $.screenBtn.setAttribute("aria-pressed", "false");
    applyShortcutLabels();
    $.screenStatus.textContent = "Off — stills only when the picture changes.";
    return;
  }
  await ensureScreenWatch();
});

$.displayBtn.addEventListener("click", async () => {
  const info = await window.copilot.cycleDisplay();
  if (info.count < 2) {
    $.displayStatus.textContent =
      "Only one display. Plug in a second monitor to keep the HUD off the shared screen.";
    return;
  }
  $.displayStatus.textContent = `HUD on display ${info.index + 1} of ${info.count}${info.primary ? " (shared/primary)" : " (presenter — better for sharing)"}`;
});

if (window.copilot) {
  window.copilot.onListenToggle(() => {
    void toggleListenShortcut();
  });
  window.copilot.onAssist(() => triggerAssist());
  window.copilot.onAssistScreen(() => {
    void requestScreenAssist();
  });
  window.copilot.onShareToggle(() => toggleShareVisibility());
  window.copilot.onAssistAction((action) => {
    if (
      action === "say_next" ||
      action === "follow_up" ||
      action === "fact_check" ||
      action === "recap"
    ) {
      void requestAssist(action);
    }
  });
  window.copilot.onContextClear(() => clearContext());
  window.copilot.onCollapsed((next) => applyCollapsed(next));
  window.copilot.onClosePops(() => closePopovers());
  window.copilot.onProfileChanged(() => {
    void loadProfile();
  });
  window.copilot.onSettingsChanged((next) => applySettings(next));
  window.copilot.onPassThrough((on) => setGhostChip(on));
  window.copilot.onToast((text) => {
    $.liveText.textContent = text;
  });
  window.copilot.onScreenFrame((frame) => {
    if (!frame.changed) {
      state.skipped += 1;
      return;
    }
    state.emitted += 1;
    state.skipped = 0;
    if (frame.dataUrl) {
      $.screenPreview.src = frame.dataUrl;
      $.screenPreview.hidden = false;
    }
    if (frame.jpegBase64) pushScreenFrame(frame.jpegBase64);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});

$.hud.addEventListener("mouseover", (event) => {
  const hit = (event.target as HTMLElement | null)?.closest?.("[data-tip]");
  if (hit instanceof HTMLElement && $.hud.contains(hit)) showHudTip(hit);
  else hideHudTip();
});
$.hud.addEventListener("mouseleave", () => hideHudTip());

async function boot() {
  markHostPlatform(window.copilot?.platform);
  if (defaultAudioSource(window.copilot?.platform ?? "", window.copilot?.osVersion ?? "") === "mic") {
    state.audioSource = "mic";
    setChip($.sourceMic, $.sourceSystem);
  }
  bindThreadScroll();
  loadAppearance();
  applyAppearance();
  if (window.copilot?.getSettings) {
    try {
      const loaded = await window.copilot.getSettings();
      applySettings(loaded.settings);
    } catch {
      applyShortcutLabels();
    }
  } else {
    applyShortcutLabels();
  }
  fillStages();
  applyCollapsed(true);
  applySessionClock();
  resetCard(
    "Ask anything, or press Assist.",
    "Answers show here when you press Enter or Assist.",
  );
  syncListenUi();
  try {
    $.sessionStatus.textContent = "Waiting for API…";
    const auth = await window.copilot.ensureAuth();
    state.token = auth.token;
    $.sessionStatus.textContent = `Signed in as device ${auth.userId.slice(0, 8)}…`;
    await refreshHistory();
    await loadProfile();
    const health = await fetch(`${window.copilot.httpUrl}/health`).then((r) =>
      r.json(),
    );
    if (!health.ok) {
      $.liveText.textContent = "API is up but not ready.";
    }
    await setCollapsed(true);
  } catch (err) {
    $.sessionStatus.textContent =
      "API/auth unavailable. Start Postgres, Redis, and `npm run dev:api`.";
    console.error(err);
  }
  if (!window.copilot) return;
  connectGateway({
    startMeetingWatch,
    stopMeetingWatch,
    refreshHistory,
    startListeningCapture,
    stopListeningCapture,
    rearmListen,
    watchAndSolveScreen,
    openHistoryAfterEnd,
  });
}

boot();
