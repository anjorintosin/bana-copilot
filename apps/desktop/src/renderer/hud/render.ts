import { INTERVIEW_STAGES, type InterviewStageId } from "@meeting-copilot/types";
import { formatAccelerator } from "../../settings";
import { formatAnswer, prettyKind } from "./answer";
import { $ } from "./dom";
import { liveTurn, saveAppearance, state, viewingLive } from "./state";

function chord(id: keyof typeof state.shortcuts) {
  return formatAccelerator(state.shortcuts[id], window.copilot?.platform ?? "darwin");
}

export function paintStages() {
  const inferred =
    state.inferredStage !== "auto"
      ? INTERVIEW_STAGES.find((item) => item.id === state.inferredStage)
      : undefined;
  $.stageSelect.replaceChildren();
  for (const stage of INTERVIEW_STAGES) {
    const option = document.createElement("option");
    option.value = stage.id;
    option.textContent =
      stage.id === "auto" && inferred ? `Auto · ${inferred.label}` : stage.label;
    option.title = stage.hint;
    $.stageSelect.append(option);
  }
  $.stageSelect.value = state.stage;
}

export function applyInferredStage(stage: InterviewStageId) {
  state.inferredStage = stage;
  paintStages();
}

export function applyAppearance() {
  $.hud.style.setProperty("--hud-alpha", String(state.opacity / 100));
  $.hud.classList.toggle("solid-hover", state.solidOnHover);
  $.opacitySlider.value = String(state.opacity);
  $.solidHover.checked = state.solidOnHover;
  $.shareVisible.checked = state.shareVisible;
  $.shareBtn.setAttribute("aria-pressed", state.shareVisible ? "true" : "false");
  const shareChord = formatAccelerator(
    state.shortcuts.share,
    window.copilot?.platform ?? "darwin",
  );
  $.shareBtn.title = state.shareVisible
    ? `Screen share — HUD visible on Zoom/Meet. ${shareChord} to hide it.`
    : `Screen share — HUD hidden from Zoom/Meet. ${shareChord} to show it.`;
}

export function applyCollapsed(next: boolean) {
  state.collapsed = next;
  $.hud.classList.toggle("collapsed", next);
  $.collapseBtn.textContent = next ? "▸" : "▾";
  if (next) closePopovers();
}

export function closePopovers() {
  $.settingsPop.hidden = true;
}

export function togglePopover() {
  $.settingsPop.hidden = !$.settingsPop.hidden;
}

export function setDot(kind: "ok" | "bad" | "") {
  $.statusDot.className = `dot ${kind}`;
}

export function setPending(text?: string) {
  if (!text) {
    $.pending.hidden = true;
    return;
  }
  $.pending.hidden = false;
  $.pending.textContent = text;
}

export function setAnswer(text: string, placeholder: boolean) {
  $.answer.classList.toggle("placeholder", placeholder);
  if (placeholder || !text) {
    $.answer.textContent = text;
    return;
  }
  const top = $.answer.scrollTop;
  $.answer.innerHTML = formatAnswer(text);
  $.answer.scrollTop = top;
}

export function setBusy(on: boolean, label = "Working on it…") {
  state.busy = on;
  $.answerLoader.hidden = !on;
  if (on) $.answerLoaderText.textContent = label;
  $.hud.classList.toggle("busy", on);
  for (const btn of $.actions.querySelectorAll("button")) {
    btn.disabled = on;
  }
  $.askInput.disabled = on;
}

export function hideAnswerLoader() {
  $.answerLoader.hidden = true;
}

export function renderTurn(index: number) {
  if (index < 0 || !state.turns[index]) {
    $.histLabel.textContent = "Live";
    $.prevBtn.disabled = true;
    $.nextBtn.disabled = true;
    return;
  }
  state.viewIndex = index;
  const turn = state.turns[index];
  const live = viewingLive();
  $.histLabel.textContent = live
    ? `Live · ${index + 1}/${state.turns.length}`
    : `${index + 1} of ${state.turns.length}`;
  $.prevBtn.disabled = index <= 0;
  $.nextBtn.disabled = index >= state.turns.length - 1;
  $.kindLabel.hidden = false;
  $.kindLabel.textContent = prettyKind(turn.kind);
  $.question.textContent = turn.question;
  $.question.classList.remove("idle");
  setPending();
  if (!turn.answer) {
    setAnswer(live ? "Thinking…" : "No answer stored.", true);
  } else {
    setAnswer(turn.answer, false);
  }
}

export function showQuestion(questionId: string, kind: string, text: string) {
  state.currentQuestionId = questionId;
  state.questionTranscript = text;
  state.turns.push({
    id: questionId,
    kind,
    question: text,
    transcript: text,
    answer: "",
    done: false,
  });
  renderTurn(state.turns.length - 1);
}

export function resetCard(message: string, answer: string) {
  state.turns = [];
  state.viewIndex = -1;
  state.currentQuestionId = "";
  state.questionTranscript = "";
  $.shotChip.hidden = true;
  $.histLabel.textContent = "Live";
  $.prevBtn.disabled = true;
  $.nextBtn.disabled = true;
  $.kindLabel.hidden = true;
  $.question.textContent = message;
  $.question.classList.add("idle");
  setPending();
  setBusy(false);
  setAnswer(answer, true);
}

export function showRecap(text: string) {
  $.question.textContent = "Session recap";
  $.question.classList.remove("idle");
  $.kindLabel.hidden = true;
  setPending();
  setAnswer(text, false);
}

export function syncListenUi() {
  $.listenPill.classList.toggle("live", Boolean(state.capture && (state.listenMode === "auto" || state.listenArmed)));
  if (!state.capture) {
    $.listenLabel.textContent = "Listen";
    $.micStatus.textContent =
      state.audioSource === "system"
        ? "Off — captures their voice, not yours."
        : "Off — microphone hears everyone in the room, including you.";
    $.meterFill.style.width = "0%";
    return;
  }
  if (state.listenMode === "shortcut") {
    $.listenLabel.textContent = state.listenArmed ? "Capturing" : "Ready";
    $.micStatus.textContent = state.listenArmed
      ? `Capturing this question. Press ${chord("listen")} again when they finish.`
      : `Ready. Press ${chord("listen")} when they start asking.`;
    return;
  }
  $.listenLabel.textContent = "Live";
  $.micStatus.textContent =
    state.audioSource === "system"
      ? "Listening to their audio. It waits until the question is finished."
      : "Mic is live. It waits until the question is finished.";
}

export function setChip(active: HTMLButtonElement, inactive: HTMLButtonElement) {
  active.classList.add("active");
  inactive.classList.remove("active");
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function applySessionClock() {
  const live = Boolean(state.sessionId);
  $.hud.classList.toggle("idle", !live);
  if (!live) {
    $.sessionBtn.textContent = "Start";
    $.sessionBtn.classList.remove("live");
    $.sessionBtn.title = "Start session";
    return;
  }
  $.sessionBtn.classList.add("live");
  $.sessionBtn.textContent = `End ${formatClock(Date.now() - state.sessionStartedAt)}`;
  $.sessionBtn.title = "End session";
}

export function startSessionClock() {
  stopSessionClock();
  state.sessionStartedAt = Date.now();
  applySessionClock();
  state.clock = window.setInterval(applySessionClock, 1000);
}

export function stopSessionClock() {
  if (state.clock) window.clearInterval(state.clock);
  state.clock = 0;
  state.sessionStartedAt = 0;
  applySessionClock();
}

export function persistLook() {
  saveAppearance();
  applyAppearance();
}

export function applyShortcutLabels() {
  $.collapseBtn.title = `Collapse to bar — ${chord("collapse")}`;
  $.hideBtn.title = `Hide — ${chord("hide")}`;
  $.homeBtn.title = `Open dashboard — ${chord("home")}`;
  $.shareBtn.title = state.shareVisible
    ? `Screen share — HUD visible on Zoom/Meet. ${chord("share")} to hide it.`
    : `Screen share — HUD hidden from Zoom/Meet. ${chord("share")} to show it.`;
  $.askInput.placeholder = `Ask AI — ${chord("assist")}`;
  $.modeShortcut.textContent = `Shortcut ${chord("listen")}`;
  $.shortcutHint.textContent = `${chord("say_next")} say · ${chord("follow_up")} follow-ups · ${chord("fact_check")} fact · ${chord("recap")} recap · ${chord("screen")} screen`;
  const labels: Record<string, string> = {
    say_next: "What should I say",
    follow_up: "Follow-ups",
    fact_check: "Fact check",
    recap: "Recap",
    screen: "Solve screen",
  };
  for (const btn of $.actions.querySelectorAll("button[data-action]")) {
    const action = btn.getAttribute("data-action") ?? "";
    const name = labels[action];
    if (!name) continue;
    const key = action === "screen" ? "screen" : action;
    btn.textContent = `${name}  ${chord(key as keyof typeof state.shortcuts)}`;
  }
}

export { prettyKind, liveTurn, viewingLive };
