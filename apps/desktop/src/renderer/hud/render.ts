import { INTERVIEW_STAGES, type InterviewStageId } from "@meeting-copilot/types";
import { formatAccelerator } from "../../settings";
import { formatAnswer, inlinePlainText, prettyKind } from "./answer";
import { markSentence } from "./highlight";
import { $ } from "./dom";
import { liveTurn, saveAppearance, state, viewingLive, type AnswerFlag } from "./state";

function chord(id: keyof typeof state.shortcuts) {
  return formatAccelerator(state.shortcuts[id], window.copilot?.platform ?? "darwin");
}

export function setTip(el: Element | null, text: string) {
  if (!(el instanceof HTMLElement)) return;
  el.setAttribute("data-tip", text);
  el.setAttribute("aria-label", text);
  el.removeAttribute("title");
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
  setTip(
    $.shareBtn,
    state.shareVisible
      ? `Visibility — shown on share — ${shareChord}`
      : `Visibility — hidden from share — ${shareChord}`,
  );
}

export function applyCollapsed(next: boolean) {
  state.collapsed = next;
  $.hud.classList.toggle("collapsed", next);
  setTip($.backBtn, next ? "Bana" : "Back");
  if (next) {
    $.askInput.placeholder = "Ask anything or solve your screen";
  } else {
    $.askInput.placeholder = "Ask follow-up…";
  }
}

export function flashHud(text: string) {
  $.liveText.textContent = text;
  const previous = $.askInput.placeholder;
  $.askInput.placeholder = text;
  window.setTimeout(() => {
    if ($.askInput.placeholder === text) {
      $.askInput.placeholder = previous || "Ask anything…";
    }
  }, 4200);
}

export function hideHudPops() {
  hideHudTip();
  $.settingsPop.hidden = true;
  $.modesPop.hidden = true;
  $.historyPop.hidden = true;
  $.hud.classList.remove("history-open");
  $.hud.classList.remove("modes-open");
  document.documentElement.classList.remove("modes-open");
  $.modesBtn.setAttribute("aria-pressed", "false");
  $.historyBtn.setAttribute("aria-pressed", "false");
}

export function closePopovers() {
  hideHudPops();
  void window.copilot?.setHudMenu(false);
}

export function hideHudTip() {
  $.hudTip.hidden = true;
}

export function showHudTip(anchor: HTMLElement) {
  const text = anchor.getAttribute("data-tip")?.trim();
  if (!text) {
    hideHudTip();
    return;
  }
  $.hudTip.textContent = text;
  $.hudTip.hidden = false;
  const hud = $.hud.getBoundingClientRect();
  const btn = anchor.getBoundingClientRect();
  const tipW = $.hudTip.offsetWidth;
  const tipH = $.hudTip.offsetHeight;
  let left = btn.left - hud.left - tipW - 8;
  if (left < 8) left = Math.min(btn.right - hud.left + 8, hud.width - tipW - 8);
  const top = btn.top - hud.top + (btn.height - tipH) / 2;
  $.hudTip.style.left = `${Math.max(8, left)}px`;
  $.hudTip.style.top = `${Math.max(4, top)}px`;
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

/** Turn whose question stays pinned at the top until the user scrolls. */
let pinnedTurnId = "";

export function bindThreadScroll() {
  const release = () => {
    pinnedTurnId = "";
  };
  $.thread.addEventListener("wheel", release, { passive: true });
  $.thread.addEventListener("touchmove", release, { passive: true });
  $.thread.addEventListener("keydown", release);
  $.thread.addEventListener("pointerdown", (event) => {
    if (event.target === $.thread) release();
  });
  new ResizeObserver(() => {
    $.thread.style.setProperty("--thread-h", `${$.thread.clientHeight}px`);
    applyPin();
  }).observe($.thread);
}

function applyPin() {
  if (!pinnedTurnId || !$.thread.clientHeight) return;
  const node = $.thread.querySelector(`[data-turn="${CSS.escape(pinnedTurnId)}"]`);
  if (!(node instanceof HTMLElement)) return;
  const top =
    node.getBoundingClientRect().top -
    $.thread.getBoundingClientRect().top +
    $.thread.scrollTop;
  $.thread.scrollTop = Math.max(0, top);
}

function pinTurn(id: string | undefined) {
  if (!id) return;
  pinnedTurnId = id;
  applyPin();
  requestAnimationFrame(applyPin);
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>';

export function makeCopyBtn() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy";
  btn.dataset.tip = "Copy";
  btn.setAttribute("aria-label", "Copy");
  btn.innerHTML = COPY_ICON;
  return btn;
}

function ensureMsgCopy(art: Element | null, show: boolean) {
  if (!(art instanceof HTMLElement)) return;
  const existing = art.querySelector(".msg-copy");
  if (!show) {
    existing?.remove();
    return;
  }
  if (!existing) art.append(makeCopyBtn());
}

export function paintThread() {
  const keepScroll = $.thread.scrollTop;
  if (!state.turns.length) {
    const idle = document.createElement("p");
    idle.className = "thread-idle";
    idle.textContent = $.question.textContent || "Ask anything, or press Assist.";
    $.thread.replaceChildren(idle);
    return;
  }
  $.thread.replaceChildren(
    ...state.turns.map((turn, index) => {
      const art = document.createElement("article");
      art.className = `msg${index === state.viewIndex ? " active" : ""}`;
      art.dataset.turn = turn.id;
      const a = document.createElement("div");
      const empty = !turn.answer;
      a.className = `msg-a${empty ? " placeholder" : ""}`;
      if (empty) {
        a.textContent =
          viewingLive() && index === state.turns.length - 1 ? "" : "No answer stored.";
      } else {
        a.innerHTML = formatAnswer(turn.answer);
      }
      const question = turn.question.replace(/\s+/g, " ").trim();
      if (question) {
        const q = document.createElement("p");
        q.className = "msg-q";
        q.textContent = question;
        art.append(q, a);
      } else {
        art.append(a);
      }
      if (!empty) art.append(makeCopyBtn());
      if (turn.flag) showFlag(art, turn.flag);
      return art;
    }),
  );
  $.thread.scrollTop = keepScroll;
  applyPin();
}

export function setAnswer(text: string, placeholder: boolean) {
  $.answer.classList.toggle("placeholder", placeholder);
  if (placeholder || !text) $.answer.textContent = text;
  else $.answer.innerHTML = formatAnswer(text);

  if (!state.turns.length) {
    paintThread();
    return;
  }
  const id = state.turns[state.viewIndex]?.id ?? liveTurn()?.id;
  const bubble = id
    ? $.thread.querySelector(`[data-turn="${CSS.escape(id)}"] .msg-a`)
    : null;
  if (!(bubble instanceof HTMLElement)) {
    paintThread();
    return;
  }
  bubble.classList.toggle("placeholder", placeholder);
  if (placeholder || !text) bubble.textContent = text;
  else bubble.innerHTML = formatAnswer(text);
  const sentence = state.turns.find((turn) => turn.id === id)?.flag?.sentence;
  if (sentence && !placeholder) markSentence(bubble, inlinePlainText(sentence));
  ensureMsgCopy(bubble.parentElement, !placeholder && Boolean(text));
  applyPin();
}

export function setBusy(on: boolean, _label = "Working on it…") {
  state.busy = on;
  $.answerLoader.hidden = true;
  if (on) {
    closePopovers();
    void window.copilot?.setCollapsed(false);
    const node = $.thread.querySelector(".msg.active") ?? $.thread.lastElementChild;
    if (node instanceof HTMLElement) pinTurn(node.dataset.turn);
  }
  $.hud.classList.toggle("busy", on);
}

export function hideAnswerLoader() {
  $.answerLoader.hidden = true;
}

export function renderTurn(index: number) {
  if (index < 0 || !state.turns[index]) {
    $.histLabel.textContent = "Live";
    $.prevBtn.disabled = true;
    $.nextBtn.disabled = true;
    paintThread();
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
  paintThread();
  pinTurn(turn.id);
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
  void window.copilot?.setCollapsed(false);
}

function makeFlag(flag: AnswerFlag) {
  const note = document.createElement("p");
  note.className = "msg-flag";
  if (flag.sentence && flag.replacement) {
    const bad = document.createElement("q");
    bad.className = "flag-bad";
    bad.textContent = inlinePlainText(flag.sentence);
    const good = document.createElement("q");
    good.className = "flag-good";
    good.textContent = flag.replacement;
    const avoid = document.createElement("span");
    avoid.className = "flag-line";
    avoid.append("Don't say ", bad);
    const instead = document.createElement("span");
    instead.className = "flag-line";
    instead.append("Say instead ", good);
    note.append(avoid, instead);
    return note;
  }
  note.textContent =
    flag.kind === "contradicts"
      ? "Check before saying: this may contradict your resume, mode, or what you already said."
      : "Check before saying: this may include details that are not in your resume or mode.";
  return note;
}

function showFlag(art: HTMLElement, flag: AnswerFlag) {
  art.querySelector(".msg-flag")?.remove();
  const copy = art.querySelector(".msg-copy");
  if (copy) copy.before(makeFlag(flag));
  else art.append(makeFlag(flag));
  const bubble = art.querySelector(".msg-a");
  if (bubble && flag.sentence) markSentence(bubble, inlinePlainText(flag.sentence));
}

export function flagAnswer(questionId: string, flag: AnswerFlag) {
  const turn = state.turns.find((item) => item.id === questionId);
  if (!turn) return;
  turn.flag = flag;
  const art = $.thread.querySelector(`[data-turn="${CSS.escape(questionId)}"]`);
  if (art instanceof HTMLElement) showFlag(art, flag);
}

export function renameQuestion(questionId: string, text: string) {
  const turn = state.turns.find((item) => item.id === questionId);
  if (!turn || !text.trim()) return;
  turn.question = text;
  if (state.turns[state.viewIndex]?.id === questionId) $.question.textContent = text;
  const bubble = $.thread.querySelector(`[data-turn="${CSS.escape(questionId)}"] .msg-q`);
  if (bubble) bubble.textContent = text.replace(/\s+/g, " ").trim();
  applyPin();
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
  $.answer.textContent = answer;
  $.answer.classList.add("placeholder");
  paintThread();
}

export function showRecap(text: string) {
  state.turns.push({
    id: `recap-${Date.now()}`,
    kind: "recap",
    question: "Session recap",
    transcript: "",
    answer: text,
    done: true,
  });
  renderTurn(state.turns.length - 1);
  void window.copilot?.setCollapsed(false);
}

export function syncListenUi() {
  $.listenPill.classList.toggle("live", Boolean(state.sessionId));
  $.listenPill.setAttribute("aria-pressed", state.sessionId ? "true" : "false");
  $.listenLabel.textContent = "Start session";
  if (!state.capture) {
    $.micStatus.textContent =
      state.audioSource === "system"
        ? "Off — captures their voice, not yours."
        : "Off — microphone hears everyone in the room, including you.";
    $.meterFill.style.width = "0%";
    return;
  }
  if (state.listenMode === "shortcut") {
    $.micStatus.textContent = state.listenArmed
      ? `Capturing this question. Press ${chord("listen")} again when they finish.`
      : `Ready. Press ${chord("listen")} when they start asking.`;
    return;
  }
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
  $.listenPill.classList.toggle("live", live);
  $.listenPill.setAttribute("aria-pressed", live ? "true" : "false");
  if (!live) {
    $.listenClock.textContent = "00:00";
    $.sessionBtn.textContent = "Start";
    $.sessionBtn.classList.remove("live");
    $.sessionBtn.title = "Start session";
    setTip($.listenPill, `Start session — ${chord("listen")}`);
    return;
  }
  const clock = formatClock(Date.now() - state.sessionStartedAt);
  $.listenClock.textContent = clock;
  $.sessionBtn.classList.add("live");
  $.sessionBtn.textContent = `End ${clock}`;
  $.sessionBtn.title = "End session";
  setTip($.listenPill, `End session — ${clock}`);
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
  setTip($.homeBtn, `Settings — ${chord("home")}`);
  setTip(
    $.shareBtn,
    state.shareVisible
      ? `Visibility — shown on share — ${chord("share")}`
      : `Visibility — hidden from share — ${chord("share")}`,
  );
  setTip($.askForm.querySelector(".send-btn"), `Assist — ${chord("assist")}`);
  setTip($.listenPill, state.sessionId ? `End session — ${chord("listen")}` : `Start session — ${chord("listen")}`);
  setTip($.screenBtn, `Screen — ${chord("screen")}`);
  setTip($.historyBtn, "History");
  const active = state.modes.find((item) => item.id === state.activeModeId);
  setTip($.modesBtn, active ? `Mode — ${active.name}` : "Mode");
}

export { prettyKind, liveTurn, viewingLive };
