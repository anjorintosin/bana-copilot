import {
  INTERVIEW_STAGES,
  type AssistAction,
  type InterviewStageId,
  type InterviewTrackId,
} from "@meeting-copilot/types";
import { formatAccelerator, type AppSettings } from "../settings";
import { startCapture, type CaptureSource } from "./audio/capture";
import "./hud/bridge";
import { $ } from "./hud/dom";
import {
  applyAppearance,
  applyCollapsed,
  applyShortcutLabels,
  closePopovers,
  paintStages,
  persistLook,
  renderTurn,
  resetCard,
  setChip,
  syncListenUi,
  togglePopover,
} from "./hud/render";
import { connectGateway, send, sendAssist, sendConfig, sendPcm } from "./hud/socket";
import { loadAppearance, state } from "./hud/state";

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
      if (perm.status !== "granted") {
        $.micStatus.textContent = `Enable ${perm.listName} in Microphone settings.`;
        await window.copilot.openMicSettings();
        return;
      }
    }

    state.capture = await startCapture({
      source: state.audioSource,
      onFrame: (pcm) => sendPcm(pcm),
      onLevel: (rms) => {
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
    });

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

async function requestAssist(action: AssistAction, text?: string) {
  const ready = await ensureSession();
  if (!ready) {
    $.liveText.textContent = "Start a session first.";
    return;
  }
  sendAssist(action, text);
}

async function requestScreenAssist() {
  const shot = await window.copilot.grabShot();
  if (!shot.ok || !shot.jpegBase64) {
    $.liveText.textContent =
      shot.error || "Could not capture the screen. Enable Screen Recording.";
    await window.copilot.openScreenSettings();
    return;
  }
  $.shotPreview.src = shot.dataUrl || "";
  $.shotChip.hidden = false;
  $.liveText.textContent = "Solving what's on screen…";
  const ready = await ensureSession();
  if (!ready) {
    $.liveText.textContent = "Start a session first.";
    return;
  }
  sendAssist("screen", undefined, { jpegBase64: shot.jpegBase64 });
}

function triggerAssist() {
  const typed = $.askInput.value.trim();
  if (typed) {
    void requestAssist("ask", typed);
    $.askInput.value = "";
    return;
  }
  void requestAssist("assist");
}

function clearContext() {
  if (!state.sessionId) {
    resetCard("Waiting for a question…", "Press Listen. It hears the other person, waits until they finish, then answers.");
    return;
  }
  send({ type: "context.clear", sessionId: state.sessionId });
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

async function refreshHistory() {
  /* session list lives on the Home dashboard */
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
}

async function showPermissionHint() {
  const info = await window.copilot.permissionInfo();
  $.permHint.textContent = `Dev permission name: “${info.listName}”. Displays: ${info.displays.length}`;
  if (info.displays.length > 1) {
    $.displayStatus.textContent = `${info.displays.length} displays — move the HUD off the one you will share.`;
  }
}

async function setCollapsed(next: boolean) {
  applyCollapsed(next);
  await window.copilot?.setCollapsed(next);
}

$.listenPill.addEventListener("click", async () => {
  try {
    if (state.capture) {
      stopListeningCapture();
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

$.sessionBtn.addEventListener("click", () => {
  if (state.sessionId) {
    $.sessionStatus.textContent = "Writing recap…";
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
});

$.homeBtn.addEventListener("click", () => {
  void window.copilot?.openHome("#overview");
});
$.shortcutsBtn.addEventListener("click", () => {
  void window.copilot?.openHome("#settings");
});
$.gearBtn.addEventListener("click", () => {
  togglePopover();
});
$.collapseBtn.addEventListener("click", () => {
  void setCollapsed(!state.collapsed);
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

$.shareBtn.addEventListener("click", () => {
  state.shareVisible = !state.shareVisible;
  persistLook();
  $.liveText.textContent = state.shareVisible
    ? "HUD visible on screen share — they can see it."
    : "HUD hidden from screen share.";
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

const grip = document.querySelector(".drag");
if (grip instanceof HTMLElement) {
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.screenX;
    lastY = event.screenY;
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    window.copilot?.moveHudBy(event.screenX - lastX, event.screenY - lastY);
    lastX = event.screenX;
    lastY = event.screenY;
  });
  grip.addEventListener("pointerup", () => {
    dragging = false;
  });
}

function setGhostChip(passThrough: boolean) {
  const live = Boolean(state.sessionId);
  $.ghostChip.hidden = !live;
  if (!live) return;
  const unlock = formatAccelerator(
    state.shortcuts.interact,
    window.copilot?.platform ?? "darwin",
  );
  $.ghostChip.textContent = passThrough
    ? `Clicks pass through the HUD — ${unlock} to use it`
    : `HUD clicks on — ${unlock} to pass through again`;
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
  triggerAssist();
});

$.answer.addEventListener("click", async (event) => {
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

$.screenBtn.addEventListener("click", async () => {
  if (state.watchingScreen) {
    await window.copilot.stopScreen();
    state.watchingScreen = false;
    $.screenPreview.hidden = true;
    $.screenBtn.textContent = "Start screen watch";
    $.screenStatus.textContent = "Off — stills only when the picture changes.";
    return;
  }
  const result = await window.copilot.startScreen();
  if (!result.ok) {
    $.screenStatus.textContent = `Screen Recording blocked. Enable ${result.listName} in Screen Recording, then retry.`;
    await window.copilot.openScreenSettings();
    return;
  }
  state.watchingScreen = true;
  state.skipped = 0;
  state.emitted = 0;
  $.screenBtn.textContent = "Stop screen watch";
  $.screenStatus.textContent =
    "Watching at ~2 fps. Stills go to the server only when the picture changes.";
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
  window.copilot.onContextClear(() => clearContext());
  window.copilot.onCollapsed((next) => applyCollapsed(next));
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
      $.screenStatus.textContent = `${frame.name}: unchanged (${state.skipped} skipped, ${state.emitted} sent)`;
      return;
    }
    state.emitted += 1;
    state.skipped = 0;
    $.screenStatus.textContent = `${frame.name}: change ${(frame.diffRatio * 100).toFixed(0)}% — event ${state.emitted}`;
    if (frame.dataUrl) {
      $.screenPreview.src = frame.dataUrl;
      $.screenPreview.hidden = false;
    }
    if (!state.sessionId) {
      $.liveText.textContent = "Screen changed, but start a session to persist it.";
      return;
    }
    if (!frame.jpegBase64) return;
    send({
      type: "screen.changed",
      sessionId: state.sessionId,
      timestamp: Date.now(),
      ocrText: "",
      imageRef: frame.sourceId,
      imageBase64: frame.jpegBase64,
      mimeType: "image/jpeg",
      diffRatio: frame.diffRatio,
    });
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});

async function boot() {
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
  applyCollapsed(false);
  resetCard(
    "Waiting for a question…",
    "Press Listen. It hears the other person, waits until they finish, then answers.",
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
    await setCollapsed(false);
  } catch (err) {
    $.sessionStatus.textContent =
      "API/auth unavailable. Start Postgres, Redis, and `npm run dev:api`.";
    console.error(err);
  }
  if (!window.copilot) return;
  await showPermissionHint();
  connectGateway({
    startMeetingWatch,
    stopMeetingWatch,
    refreshHistory,
    startListeningCapture,
    stopListeningCapture,
    rearmListen,
  });
}

boot();
