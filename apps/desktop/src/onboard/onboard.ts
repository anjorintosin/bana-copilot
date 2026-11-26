import {
  loopbackDeniedCopy,
  markHostPlatform,
  mediaIsBlocked,
  permissionIntro,
  systemAudioSupported,
} from "../compat";
import { eventToAccelerator, formatAccelerator } from "../settings";
import "../renderer/hud/bridge";

markHostPlatform(window.copilot?.platform);

type Step = "perms" | "done";

const $ = {
  assistChord: document.getElementById("assist-chord") as HTMLElement,
  assistHint: document.getElementById("assist-hint") as HTMLSpanElement,
  assistBadge: document.getElementById("assist-badge") as HTMLSpanElement,
  audioHint: document.getElementById("audio-hint") as HTMLSpanElement,
  audioBadge: document.getElementById("audio-badge") as HTMLSpanElement,
  audioCheck: document.getElementById("audio-check") as HTMLButtonElement,
  screenHint: document.getElementById("screen-hint") as HTMLSpanElement,
  screenBadge: document.getElementById("screen-badge") as HTMLSpanElement,
  screenCheck: document.getElementById("screen-check") as HTMLButtonElement,
  loopbackRow: document.getElementById("loopback-row") as HTMLDivElement,
  loopbackHint: document.getElementById("loopback-hint") as HTMLSpanElement,
  loopbackBadge: document.getElementById("loopback-badge") as HTMLSpanElement,
  loopbackCheck: document.getElementById("loopback-check") as HTMLButtonElement,
  permStatus: document.getElementById("perm-status") as HTMLParagraphElement,
  permsLede: document.getElementById("perms-lede") as HTMLParagraphElement,
  permsContinue: document.getElementById("perms-continue") as HTMLButtonElement,
  doneContinue: document.getElementById("done-continue") as HTMLButtonElement,
};

let token = "";
let assistAccel = "CommandOrControl+Enter";
let assistOk = false;
let listeningAssist = false;
let loopbackOk = false;
let micOk = false;
let granting = false;

function needsLoopback() {
  return systemAudioSupported(window.copilot?.platform ?? "", window.copilot?.osVersion ?? "");
}

function show(step: Step) {
  for (const id of ["perms", "done"]) {
    const el = document.getElementById(`step-${id}`);
    if (el) el.hidden = id !== step;
  }
  if (step === "perms") {
    if (!assistOk) {
      setBadge($.assistBadge, "", "Optional");
      $.assistHint.innerHTML = `Press <kbd id="assist-chord">${assistChordLabel()}</kbd> to try it. Optional.`;
      $.assistChord = document.getElementById("assist-chord") as HTMLElement;
    }
    startAssistCheck();
    void refreshPerms();
  } else {
    stopAssistCheck();
  }
}

function setBadge(el: HTMLElement, kind: "ok" | "wait" | "bad" | "", text: string) {
  el.className = kind ? `perm-badge ${kind}` : "perm-badge";
  if (kind === "ok") {
    el.innerHTML = "✓";
    el.title = "Ready";
  } else {
    el.textContent = text;
    el.removeAttribute("title");
  }
}

function assistChordLabel() {
  return formatAccelerator(assistAccel, window.copilot?.platform ?? "darwin");
}

function onAssistKey(event: KeyboardEvent) {
  if (eventToAccelerator(event) !== assistAccel) return;
  event.preventDefault();
  assistOk = true;
  setBadge($.assistBadge, "ok", "Ready");
  $.assistHint.innerHTML = `Assist is <kbd>${assistChordLabel()}</kbd>. It only fires during a session.`;
}

function startAssistCheck() {
  if (listeningAssist) return;
  listeningAssist = true;
  window.addEventListener("keydown", onAssistKey);
}

function stopAssistCheck() {
  if (!listeningAssist) return;
  listeningAssist = false;
  window.removeEventListener("keydown", onAssistKey);
}

async function refreshPerms() {
  if (!window.copilot) return;
  if ($.permsLede) $.permsLede.textContent = permissionIntro(window.copilot.platform);
  const info = await window.copilot.permissionInfo();
  const mic = info.mic ?? info.status;
  const appName = info.listName;
  if (mic === "granted" || micOk) {
    setBadge($.audioBadge, "ok", "Ready");
    $.audioHint.textContent = "Microphone is allowed.";
    $.audioCheck.hidden = true;
  } else {
    setBadge($.audioBadge, mic === "denied" ? "bad" : "wait", mic === "denied" ? "Blocked" : "Needed");
    $.audioHint.textContent =
      mic === "denied"
        ? `Turn on ${appName} in Microphone settings, then recheck.`
        : "Listen uses your mic when you ask it to.";
    $.audioCheck.hidden = false;
    $.audioCheck.textContent = mic === "denied" ? "Open settings" : "Check";
  }

  const screen = await window.copilot.probeScreen();
  if (screen.ok) {
    setBadge($.screenBadge, "ok", "Ready");
    $.screenHint.textContent = "Screen capture is allowed.";
    $.screenCheck.hidden = true;
  } else {
    const blocked = screen.status === "denied";
    setBadge($.screenBadge, blocked ? "bad" : "wait", blocked ? "Blocked" : "Needed");
    $.screenHint.textContent = blocked
      ? `Turn on ${screen.listName} in Screen Recording, then recheck.`
      : "Assist can see what’s on your display.";
    $.screenCheck.hidden = false;
    $.screenCheck.textContent = blocked ? "Open settings" : "Check";
  }

  const meetingReady = loopbackOk;
  if (meetingReady) {
    setBadge($.loopbackBadge, "ok", "Ready");
    $.loopbackHint.textContent = "Meeting audio is allowed.";
    $.loopbackCheck.hidden = true;
  } else {
    setBadge($.loopbackBadge, "wait", "Needed");
    $.loopbackHint.textContent = "Zoom, Meet, and Teams — not your microphone.";
    $.loopbackCheck.hidden = false;
    $.loopbackCheck.textContent = "Check";
  }
}

async function allowMic(openSettings: boolean) {
  if (!window.copilot) return;
  const perm = await window.copilot.requestMic();
  if (!mediaIsBlocked(perm.status)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      micOk = true;
    } catch {
      micOk = false;
    }
  } else if (openSettings) {
    await window.copilot.openMicSettings();
  }
}

async function allowScreen(openSettings: boolean) {
  if (!window.copilot) return;
  const listed = await window.copilot.probeScreen();
  if (!listed.ok && openSettings) await window.copilot.openScreenSettings();
}

async function allowLoopback(openSettings: boolean) {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    loopbackOk = stream.getAudioTracks().some((track) => track.readyState === "live");
    stream.getTracks().forEach((track) => track.stop());
    if (!loopbackOk && openSettings) {
      $.permStatus.textContent = loopbackDeniedCopy(window.copilot?.platform ?? "darwin");
      await window.copilot.openScreenSettings();
    }
  } catch {
    loopbackOk = false;
    if (openSettings) {
      $.permStatus.textContent = loopbackDeniedCopy(window.copilot?.platform ?? "darwin");
      await window.copilot.openScreenSettings();
    }
  }
}

$.audioCheck.addEventListener("click", async () => {
  $.audioCheck.disabled = true;
  $.permStatus.textContent = "Asking for the microphone…";
  try {
    await allowMic(true);
    await refreshPerms();
    $.permStatus.textContent = "";
  } finally {
    $.audioCheck.disabled = false;
  }
});

$.screenCheck.addEventListener("click", async () => {
  $.screenCheck.disabled = true;
  $.permStatus.textContent = "Asking for screen access…";
  try {
    await allowScreen(true);
    await refreshPerms();
    $.permStatus.textContent = "";
  } finally {
    $.screenCheck.disabled = false;
  }
});

$.loopbackCheck.addEventListener("click", async () => {
  $.loopbackCheck.disabled = true;
  $.permStatus.textContent = "Asking for meeting audio…";
  try {
    await allowLoopback(true);
    await refreshPerms();
    if (loopbackOk) $.permStatus.textContent = "";
  } finally {
    $.loopbackCheck.disabled = false;
  }
});

window.addEventListener("focus", () => {
  if (!document.getElementById("step-perms")?.hidden) void refreshPerms();
});

$.permsContinue.addEventListener("click", () => show("done"));
$.doneContinue.addEventListener("click", () => {
  void window.copilot.finishOnboard();
});

async function boot() {
  if (!window.copilot) return;
  markHostPlatform(window.copilot.platform);
  if ($.permsLede) $.permsLede.textContent = permissionIntro(window.copilot.platform);
  $.loopbackRow.hidden = !needsLoopback();
  try {
    const settings = await window.copilot.getSettings();
    assistAccel = settings.settings.shortcuts.assist;
    const chord = assistChordLabel();
    if ($.assistChord) $.assistChord.textContent = chord;
    const auth = await window.copilot.ensureAuth();
    token = auth.token;
  } catch {
    /* non-blocking */
  }
  show("perms");
}

boot();
