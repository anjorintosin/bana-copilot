import { LIMITS, sanitizeSecret, sanitizeText, type AnswerMode, type AnswerModeList, type BillingAccount } from "@meeting-copilot/types";
import { markHostPlatform } from "../compat";
import { CODING_INTERVIEW_CONTEXT } from "./codingModeContext";
import {
  DEFAULT_SETTINGS,
  SHORTCUT_META,
  eventToAccelerator,
  formatAccelerator,
  type AppSettings,
  type ShortcutId,
} from "../settings";
import "../renderer/hud/bridge";

markHostPlatform(window.copilot?.platform);

type Account = BillingAccount;
type Page = "general" | "modes" | "shortcuts" | "history" | "about";
const pages: Page[] = ["general", "modes", "shortcuts", "history", "about"];

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

const $ = {
  shortcutList: document.getElementById("shortcut-list") as HTMLDivElement,
  resetShortcuts: document.getElementById("reset-shortcuts") as HTMLButtonElement,
  shortcutStatus: document.getElementById("shortcut-status") as HTMLParagraphElement,
  settingsOpacity: document.getElementById("settings-opacity") as HTMLInputElement,
  settingsOpacityValue: document.getElementById("settings-opacity-value") as HTMLElement,
  settingsSolid: document.getElementById("settings-solid") as HTMLInputElement,
  settingsShareVisible: document.getElementById("settings-share-visible") as HTMLInputElement,
  sessionTable: document.getElementById("session-table") as HTMLDivElement,
  knowledgeText: document.getElementById("knowledge-text") as HTMLTextAreaElement,
  knowledgeFile: document.getElementById("knowledge-file") as HTMLInputElement,
  knowledgeSave: document.getElementById("knowledge-save") as HTMLButtonElement,
  knowledgeStatus: document.getElementById("knowledge-status") as HTMLParagraphElement,
  quitBtn: document.getElementById("quit-btn") as HTMLButtonElement,
  modesCards: document.getElementById("modes-cards") as HTMLDivElement,
  modeEditor: document.getElementById("mode-editor") as HTMLDivElement,
  modeNew: document.getElementById("mode-new") as HTMLButtonElement,
  modeName: document.getElementById("mode-name") as HTMLInputElement,
  modeInstructions: document.getElementById("mode-instructions") as HTMLTextAreaElement,
  modeCodingTemplate: document.getElementById("mode-coding-template") as HTMLButtonElement,
  modeBuiltinHint: document.getElementById("mode-builtin-hint") as HTMLParagraphElement,
  modeDocs: document.getElementById("mode-docs") as HTMLDivElement,
  modeSave: document.getElementById("mode-save") as HTMLButtonElement,
  modeDelete: document.getElementById("mode-delete") as HTMLButtonElement,
};

let token = "";
let pendingPdf: { name: string; data: string } | null = null;
let currentSettings: AppSettings | null = null;
let recording: ShortcutId | null = null;
let modesList: AnswerModeList = { modes: [], activeModeId: "" };
let editingModeId = "";
let draftingMode = false;

function pageFromHash(): Page {
  const raw = location.hash.replace("#", "").split("/")[0];
  if (raw === "settings") return "general";
  if (raw === "overview") return "general";
  return pages.includes(raw as Page) ? (raw as Page) : "general";
}

function showPage(page: Page) {
  if (location.hash.replace("#", "").split("/")[0] !== page) {
    history.replaceState(null, "", `#${page}`);
  }
  for (const id of pages) {
    const section = document.getElementById(`page-${id}`);
    if (section) section.hidden = id !== page;
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    btn.classList.toggle("active", btn.dataset.page === page);
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

function editingMode(): AnswerMode | undefined {
  return modesList.modes.find((item) => item.id === editingModeId);
}

function applyModes(listed: AnswerModeList) {
  modesList = listed;
  if (editingModeId && !listed.modes.some((item) => item.id === editingModeId)) {
    editingModeId = "";
  }
  renderModeCards();
  fillModeEditor();
}

function parkEditor() {
  document.getElementById("page-modes")?.append($.modeEditor);
}

function modeMeta(mode: AnswerMode) {
  const titles = (mode.documents ?? []).map((doc) => doc.title).filter(Boolean);
  const count = mode.documentCount;
  const files = count
    ? `${count} file${count === 1 ? "" : "s"}${titles.length ? ` · ${titles.slice(0, 2).join(", ")}` : ""}`
    : "No files yet";
  return mode.builtin ? `Built in · ${files}` : files;
}

function renderModeCards() {
  parkEditor();
  const cards: HTMLElement[] = [];
  if (draftingMode) cards.push(buildDraftCard());
  for (const mode of modesList.modes) cards.push(buildModeCard(mode));
  $.modesCards.replaceChildren(...cards);
  const body = $.modesCards.querySelector(".mode-item.expanded .mode-body");
  if (body) {
    body.append($.modeEditor);
    $.modeEditor.hidden = false;
  } else {
    $.modeEditor.hidden = true;
  }
}

function buildDraftCard() {
  const item = document.createElement("article");
  item.className = "mode-item draft expanded";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "mode-head";
  head.innerHTML = `<div><strong>New mode</strong><span class="mode-meta">Name it, say how to answer, then save.</span></div><span class="mode-chevron">▾</span>`;
  const body = document.createElement("div");
  body.className = "mode-body";
  item.append(head, body);
  return item;
}

function buildModeCard(mode: AnswerMode) {
  const item = document.createElement("article");
  const open = !draftingMode && mode.id === editingModeId;
  item.className = `mode-item${mode.id === modesList.activeModeId ? " current" : ""}${open ? " expanded" : ""}`;
  const head = document.createElement("div");
  head.className = "mode-head";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = mode.name;
  const meta = document.createElement("span");
  meta.className = "mode-meta";
  meta.textContent = modeMeta(mode);
  copy.append(title, meta);
  const actions = document.createElement("div");
  actions.className = "mode-head-actions";
  const use = document.createElement("button");
  use.type = "button";
  use.className = `mode-use${mode.id === modesList.activeModeId ? " on" : ""}`;
  use.textContent = mode.id === modesList.activeModeId ? "In use" : "Use";
  use.addEventListener("click", (event) => {
    event.stopPropagation();
    if (mode.id === modesList.activeModeId || !token) return;
    void (async () => {
      const listed = await window.copilot.selectMode(token, mode.id);
      if (listed.error) {
        $.knowledgeStatus.textContent = listed.error;
        return;
      }
      draftingMode = false;
      applyModes(listed);
    })();
  });
  const chev = document.createElement("span");
  chev.className = "mode-chevron";
  chev.textContent = "▾";
  actions.append(use, chev);
  head.append(copy, actions);
  head.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".mode-use")) return;
    if (open) {
      editingModeId = "";
      draftingMode = false;
      renderModeCards();
      return;
    }
    draftingMode = false;
    editingModeId = mode.id;
    renderModeCards();
    fillModeEditor();
  });
  const body = document.createElement("div");
  body.className = "mode-body";
  item.append(head, body);
  return item;
}

function fillModeEditor() {
  if (draftingMode) return;
  const mode = editingMode();
  if (!mode) {
    $.modeEditor.hidden = true;
    return;
  }
  $.modeEditor.hidden = false;
  const builtin = Boolean(mode?.builtin);
  $.modeName.value = mode?.name ?? "";
  $.modeInstructions.value = mode?.instructions ?? "";
  $.modeName.disabled = builtin;
  $.modeInstructions.disabled = builtin;
  $.modeBuiltinHint.hidden = !builtin;
  $.modeDelete.hidden = !mode || builtin;
  $.modeSave.hidden = builtin;
  $.modeCodingTemplate.hidden = builtin;
  $.knowledgeSave.textContent = "Add knowledge";
  renderModeDocs(mode);
}

function renderModeDocs(mode: AnswerMode | undefined) {
  const docs = mode?.documents ?? [];
  if (!docs.length) {
    $.modeDocs.replaceChildren();
    $.modeDocs.hidden = true;
    return;
  }
  $.modeDocs.hidden = false;
  $.modeDocs.replaceChildren(
    ...docs.map((doc) => {
      const row = document.createElement("div");
      row.className = "doc-row";
      row.innerHTML = `<div><strong>${doc.title}</strong><span>${doc.chars} chars</span></div>`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (!token || !mode) return;
        void (async () => {
          const listed = await window.copilot.deleteModeDocument(token, mode.id, doc.id);
          if (listed.error) {
            $.knowledgeStatus.textContent = listed.error;
            return;
          }
          applyModes(listed);
        })();
      });
      row.append(remove);
      return row;
    }),
  );
}

function startNewMode() {
  draftingMode = true;
  editingModeId = "";
  $.modeName.disabled = false;
  $.modeInstructions.disabled = false;
  $.modeName.value = "";
  $.modeInstructions.value = "";
  $.modeBuiltinHint.hidden = true;
  $.modeDelete.hidden = true;
  $.modeSave.hidden = false;
  $.modeCodingTemplate.hidden = false;
  $.modeDocs.replaceChildren();
  $.modeDocs.hidden = true;
  $.knowledgeStatus.textContent = "Name it, say how to answer, then save. Knowledge is optional.";
  renderModeCards();
  $.modeName.focus();
}

async function loadModes() {
  if (!token) return;
  const listed = await window.copilot.listModes(token);
  if (listed.error) {
    $.knowledgeStatus.textContent = listed.error;
    return;
  }
  applyModes(listed);
}

function renderSessions(rows: SessionRow[]) {
  if (!rows.length) {
    $.sessionTable.textContent = "No sessions yet.";
    return;
  }
  $.sessionTable.replaceChildren(
    ...rows.map((row) => {
      const el = document.createElement("div");
      el.className = "session-row";
      const when = new Date(row.started_at).toLocaleString();
      const role = [row.job_title, row.company].filter(Boolean).join(" · ");
      el.innerHTML = `<div><strong>${row.status}</strong> <span>${when}</span></div>
        <div>${role || "General"}${row.meeting_app ? ` · ${row.meeting_app}` : ""}</div>
        <span>${row.transcript_count} turns</span>`;
      return el;
    }),
  );
}

function fillKey(_account: Account) {
  // Model key is provided centrally from environment
}

function renderShortcuts(settings: AppSettings) {
  currentSettings = settings;
  const platform = window.copilot?.platform ?? "darwin";
  $.shortcutList.replaceChildren(
    ...SHORTCUT_META.map((meta) => {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      if (recording === meta.id) row.classList.add("recording");
      row.innerHTML = `<div><strong>${meta.label}</strong><span>${meta.hint}</span></div>
        <kbd>${recording === meta.id ? "Press keys…" : formatAccelerator(settings.shortcuts[meta.id], platform)}</kbd>
        <button type="button" class="ghost">${recording === meta.id ? "Cancel" : "Change"}</button>`;
      row.querySelector("button")?.addEventListener("click", () => {
        recording = recording === meta.id ? null : meta.id;
        renderShortcuts(settings);
      });
      return row;
    }),
  );
  $.settingsOpacity.value = String(settings.look.opacity);
  $.settingsOpacityValue.textContent = `${settings.look.opacity}%`;
  $.settingsSolid.checked = settings.look.solidOnHover;
  $.settingsShareVisible.checked = !settings.look.shareVisible;
}

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page as Page));
});

$.knowledgeFile.addEventListener("change", async () => {
  const file = $.knowledgeFile.files?.[0];
  if (!file) return;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    if (file.size > 8_000_000) {
      pendingPdf = null;
      $.knowledgeStatus.textContent = "File is too large (max 8 MB).";
      return;
    }
    pendingPdf = { name: file.name, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
    $.knowledgeText.value = "";
    $.knowledgeStatus.textContent = `File selected: ${file.name}`;
    return;
  }
  pendingPdf = null;
  $.knowledgeText.value = await file.text();
  $.knowledgeStatus.textContent = `Loaded ${file.name}`;
});

$.knowledgeSave.addEventListener("click", async () => {
  if (!token) return;
  const mode = editingMode();
  if (!mode) {
    $.knowledgeStatus.textContent = "Save the mode first, then add knowledge.";
    return;
  }
  $.knowledgeSave.disabled = true;
  $.knowledgeStatus.textContent = "Saving…";
  try {
    const listed = await window.copilot.addModeDocument(token, mode.id, {
      title: pendingPdf?.name || ($.knowledgeText.value.trim().slice(0, 40) || "Notes"),
      text: pendingPdf ? undefined : sanitizeText($.knowledgeText.value, { max: LIMITS.document }),
      pdfBase64: pendingPdf?.data,
    });
    if (listed.error) {
      $.knowledgeStatus.textContent = listed.error;
      return;
    }
    pendingPdf = null;
    $.knowledgeFile.value = "";
    $.knowledgeText.value = "";
    applyModes(listed);
    $.knowledgeStatus.textContent = `Added to ${mode.name}.`;
  } catch (err) {
    $.knowledgeStatus.textContent = err instanceof Error ? err.message : "Could not save.";
  } finally {
    $.knowledgeSave.disabled = false;
  }
});

$.modeNew.addEventListener("click", () => startNewMode());

$.modeCodingTemplate.addEventListener("click", () => {
  if ($.modeInstructions.disabled) return;
  if (!$.modeName.value.trim()) $.modeName.value = "Coding";
  $.modeInstructions.value = CODING_INTERVIEW_CONTEXT;
  $.knowledgeStatus.textContent = "Coding interview context filled. Save the mode, then press Use.";
});

$.modeSave.addEventListener("click", async () => {
  if (!token) return;
  $.modeSave.disabled = true;
  $.knowledgeStatus.textContent = "Saving…";
  try {
    const body = {
      name: $.modeName.value,
      instructions: $.modeInstructions.value,
    };
    const listed = editingModeId
      ? await window.copilot.updateMode(token, editingModeId, body)
      : await window.copilot.createMode(token, body);
    if (listed.error) {
      $.knowledgeStatus.textContent = listed.error;
      return;
    }
    draftingMode = false;
    editingModeId = listed.activeModeId;
    applyModes(listed);
    $.knowledgeStatus.textContent = "Mode saved. Assist will use it on the next answer.";
  } catch (err) {
    $.knowledgeStatus.textContent = err instanceof Error ? err.message : "Could not save mode.";
  } finally {
    $.modeSave.disabled = false;
  }
});

$.modeDelete.addEventListener("click", async () => {
  if (!token || !editingModeId) return;
  const mode = editingMode();
  if (!mode || mode.builtin) return;
  $.modeDelete.disabled = true;
  try {
    const listed = await window.copilot.deleteMode(token, editingModeId);
    if (listed.error) {
      $.knowledgeStatus.textContent = listed.error;
      return;
    }
    editingModeId = "";
    applyModes(listed);
    $.knowledgeStatus.textContent = `${mode.name} deleted. Back on ${listed.modes.find((item) => item.id === listed.activeModeId)?.name ?? "General"}.`;
  } catch (err) {
    $.knowledgeStatus.textContent = err instanceof Error ? err.message : "Could not delete.";
  } finally {
    $.modeDelete.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    recording = null;
    if (currentSettings) renderShortcuts(currentSettings);
    return;
  }
  const accelerator = eventToAccelerator(event);
  if (!accelerator) return;
  const id = recording;
  recording = null;
  void (async () => {
    const result = await window.copilot.saveSettings({ shortcuts: { [id]: accelerator } });
    $.shortcutStatus.textContent = result.ok
      ? `${SHORTCUT_META.find((item) => item.id === id)?.label} is now ${formatAccelerator(accelerator, window.copilot.platform)}.`
      : result.error || "Could not save shortcut.";
    if (result.settings) renderShortcuts(result.settings);
  })();
});

$.resetShortcuts.addEventListener("click", async () => {
  const result = await window.copilot.resetShortcuts();
  $.shortcutStatus.textContent = result.ok ? "Shortcuts reset to defaults." : result.error || "Could not reset.";
  if (result.settings) renderShortcuts(result.settings);
});

$.settingsOpacity.addEventListener("input", () => {
  const opacity = Number($.settingsOpacity.value);
  $.settingsOpacityValue.textContent = `${opacity}%`;
  void window.copilot.saveSettings({ look: { opacity } });
});

$.settingsSolid.addEventListener("change", () => {
  void window.copilot.saveSettings({ look: { solidOnHover: $.settingsSolid.checked } });
});

$.settingsShareVisible.addEventListener("change", () => {
  void window.copilot.saveSettings({ look: { shareVisible: !$.settingsShareVisible.checked } });
});

$.quitBtn.addEventListener("click", () => {
  void window.copilot.quitApp();
});

window.addEventListener("hashchange", () => showPage(pageFromHash()));

async function boot() {
  renderShortcuts(DEFAULT_SETTINGS);
  showPage(pageFromHash());
  if (!window.copilot) return;
  try {
    const auth = await window.copilot.ensureAuth();
    token = auth.token;
    const [account, sessions] = await Promise.all([
      window.copilot.getAccount(token),
      window.copilot.listSessions(token),
    ]);
    fillKey(account);
    renderSessions(sessions.sessions ?? []);
    await loadModes();
    const loaded = await window.copilot.getSettings();
    renderShortcuts(loaded.settings);
    window.copilot.onProfileChanged(() => {
      void boot();
    });
    window.copilot.onSettingsChanged((next) => renderShortcuts(next));
  } catch {
    /* API down */
  }
}

boot();
