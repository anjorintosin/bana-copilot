import { LIMITS, sanitizeSecret, sanitizeText } from "@meeting-copilot/types";
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

type Step = "key" | "knowledge" | "perms" | "done";

const $ = {
  keyProvider: document.getElementById("key-provider") as HTMLSelectElement,
  keyValue: document.getElementById("key-value") as HTMLInputElement,
  keyStatus: document.getElementById("key-status") as HTMLParagraphElement,
  keyContinue: document.getElementById("key-continue") as HTMLButtonElement,
  knowledgeText: document.getElementById("knowledge-text") as HTMLTextAreaElement,
  knowledgeFile: document.getElementById("knowledge-file") as HTMLInputElement,
  knowledgeStatus: document.getElementById("knowledge-status") as HTMLParagraphElement,
  knowledgeSkip: document.getElementById("knowledge-skip") as HTMLButtonElement,
  knowledgeContinue: document.getElementById("knowledge-continue") as HTMLButtonElement,
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
let pendingPdf: { name: string; data: string } | null = null;
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
  for (const id of ["key", "knowledge", "perms", "done"]) {
    const el = document.getElementById(`step-${id}`);
    if (el) el.hidden = id !== step;
  }
  if (step === "perms") {
    if (!assistOk) {
      setBadge($.assistBadge, "wait", "Waiting");
      $.assistHint.innerHTML = `Press <kbd id="assist-chord">${assistChordLabel()}</kbd> now to confirm.`;
      $.assistChord = document.getElementById("assist-chord") as HTMLElement;
    }
    startAssistCheck();
    void grantAllPerms();
  } else {
    stopAssistCheck();
  }
}

function setBadge(el: HTMLElement, kind: "ok" | "wait" | "bad" | "", text: string) {
  el.className = kind ? `perm-badge ${kind}` : "perm-badge";
  el.textContent = text;
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

function actionLabel(ok: boolean, status?: string) {
  if (ok || status === "granted") return "Recheck";
  if (status === "denied") return "Open settings";
  return "Allow";
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
  } else {
    setBadge($.audioBadge, mic === "denied" ? "bad" : "wait", mic === "denied" ? "Blocked" : "Needed");
    $.audioHint.textContent =
      mic === "denied"
        ? `Turn on ${appName} in Microphone settings, then recheck.`
        : "Listen uses your mic when you ask it to.";
  }
  $.audioCheck.textContent = actionLabel(mic === "granted" || micOk, mic);

  const screen = await window.copilot.probeScreen();
  if (screen.ok) {
    setBadge($.screenBadge, "ok", "Ready");
    $.screenHint.textContent = "Screen capture is allowed.";
  } else {
    const blocked = screen.status === "denied";
    setBadge($.screenBadge, blocked ? "bad" : "wait", blocked ? "Blocked" : "Needed");
    $.screenHint.textContent = blocked
      ? `Turn on ${screen.listName} in Screen Recording, then recheck.`
      : "Assist can see what’s on your display.";
  }
  $.screenCheck.textContent = actionLabel(screen.ok, screen.status);

  if (loopbackOk) {
    setBadge($.loopbackBadge, "ok", "Ready");
    $.loopbackHint.textContent = "Meeting audio is allowed.";
  } else {
    setBadge($.loopbackBadge, "wait", "Needed");
    $.loopbackHint.textContent = "Zoom, Meet, and Teams — not your microphone.";
  }
  $.loopbackCheck.textContent = loopbackOk ? "Recheck" : "Allow";
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

async function grantAllPerms() {
  if (granting || !window.copilot) return;
  granting = true;
  $.permStatus.textContent = "Allow the prompts that appear…";
  try {
    await allowMic(false);
    await allowScreen(false);
    if (needsLoopback()) await allowLoopback(false);
    await refreshPerms();
    $.permStatus.textContent = "";
  } finally {
    granting = false;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

$.keyValue.addEventListener("input", () => {
  const value = $.keyValue.value.trim();
  if (value.startsWith("sk-ant-")) $.keyProvider.value = "claude";
  else if (value.startsWith("xai-")) $.keyProvider.value = "grok";
});

$.keyContinue.addEventListener("click", async () => {
  if (!token) return;
  const raw = $.keyValue.value.trim();
  if (!raw) {
    try {
      const account = await window.copilot.getAccount(token);
      if (account.key.configured) {
        show("knowledge");
        return;
      }
    } catch {
      /* fall through */
    }
    $.keyStatus.textContent = "Paste a key to continue.";
    return;
  }
  $.keyContinue.disabled = true;
  $.keyStatus.textContent = "Checking this key…";
  try {
    const next = await window.copilot.billingSaveKey(token, {
      provider: $.keyProvider.value,
      apiKey: sanitizeSecret($.keyValue.value),
    });
    if (next.error) {
      $.keyStatus.textContent = next.error;
      return;
    }
    show("knowledge");
  } catch (err) {
    $.keyStatus.textContent = err instanceof Error ? err.message : "Could not save key.";
  } finally {
    $.keyContinue.disabled = false;
  }
});

$.knowledgeFile.addEventListener("change", async () => {
  const file = $.knowledgeFile.files?.[0];
  if (!file) return;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    if (file.size > 8_000_000) {
      $.knowledgeStatus.textContent = "File is too large (max 8 MB).";
      return;
    }
    pendingPdf = { name: file.name, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
    $.knowledgeText.value = "";
    $.knowledgeStatus.textContent = file.name;
    return;
  }
  pendingPdf = null;
  $.knowledgeText.value = await file.text();
  $.knowledgeStatus.textContent = file.name;
});

async function saveKnowledge() {
  if (!token) return true;
  const text = $.knowledgeText.value.trim();
  if (!pendingPdf && !text) return true;
  const listed = await window.copilot.listModes(token);
  const general = listed.modes?.find((item) => item.builtin) ?? listed.modes?.[0];
  if (listed.error || !general) {
    const result = await window.copilot.saveResume(token, {
      title: pendingPdf?.name || "General knowledge",
      text: pendingPdf ? undefined : sanitizeText(text, { max: LIMITS.document }),
      pdfBase64: pendingPdf?.data,
    });
    if (result.error) {
      $.knowledgeStatus.textContent = result.error;
      return false;
    }
    return true;
  }
  const result = await window.copilot.addModeDocument(token, general.id, {
    title: pendingPdf?.name || "General knowledge",
    text: pendingPdf ? undefined : sanitizeText(text, { max: LIMITS.document }),
    pdfBase64: pendingPdf?.data,
  });
  if (result.error) {
    $.knowledgeStatus.textContent = result.error;
    return false;
  }
  return true;
}

$.knowledgeSkip.addEventListener("click", () => show("perms"));
$.knowledgeContinue.addEventListener("click", async () => {
  $.knowledgeContinue.disabled = true;
  try {
    if (await saveKnowledge()) show("perms");
  } finally {
    $.knowledgeContinue.disabled = false;
  }
});

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
    const account = await window.copilot.getAccount(token);
    if (account.key.configured) {
      $.keyStatus.textContent = `A key is already saved (${account.key.provider ?? "key"} …${account.key.last4}). Continue, or replace it.`;
    }
  } catch (err) {
    $.keyStatus.textContent = err instanceof Error ? err.message : "Could not reach the API.";
  }
}

boot();
