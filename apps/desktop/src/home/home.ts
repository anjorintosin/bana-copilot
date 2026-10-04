import {
  DOCUMENT_KINDS,
  INTERVIEW_TRACKS,
  LIMITS,
  sanitizeLine,
  sanitizeSecret,
  sanitizeText,
  storyIsRehearsed,
  type BillingAccount,
  type DocumentKind,
  type InterviewTrackId,
  type PracticeQuestion,
  type StoriesStatus,
  type Story,
} from "@meeting-copilot/types";
import { formatAnswer, prettyKind } from "../renderer/hud/answer";
import {
  DEFAULT_SETTINGS,
  SHORTCUT_META,
  eventToAccelerator,
  formatAccelerator,
  type AppSettings,
  type ShortcutId,
} from "../settings";
import "../renderer/hud/bridge";

type Profile = {
  jobTitle?: string;
  company?: string;
  requirements?: string;
  defaultTrack?: string;
  plan?: string;
  storiesStatus?: StoriesStatus | string;
  storyCount?: number;
  resume?: { title: string; chunkCount: number; excerpt: string } | null;
  error?: string;
};

type SessionRow = {
  id: string;
  status: string;
  started_at: string;
  transcript_count: number;
  screen_count: number;
  summary?: string | null;
  meeting_app?: string | null;
  job_title?: string | null;
  company?: string | null;
};

type Doc = {
  id: string;
  kind: DocumentKind;
  title: string;
  excerpt: string;
  text: string;
  chars: number;
  createdAt: string;
};

type Account = BillingAccount;

const pages = ["overview", "documents", "stories", "practice", "sessions", "plan", "settings"] as const;
type Page = (typeof pages)[number];

const $ = {
  planChip: document.getElementById("plan-chip") as HTMLElement,
  lede: document.getElementById("overview-lede") as HTMLParagraphElement,
  jobTitle: document.getElementById("job-title") as HTMLInputElement,
  jobCompany: document.getElementById("job-company") as HTMLInputElement,
  jobRequirements: document.getElementById("job-requirements") as HTMLTextAreaElement,
  defaultTrack: document.getElementById("default-track") as HTMLSelectElement,
  saveRole: document.getElementById("save-role") as HTMLButtonElement,
  roleStatus: document.getElementById("role-status") as HTMLParagraphElement,
  readyList: document.getElementById("ready-list") as HTMLUListElement,
  resumeStatus: document.getElementById("resume-status") as HTMLParagraphElement,
  storyStatus: document.getElementById("story-status") as HTMLParagraphElement,
  storiesStatus: document.getElementById("stories-status") as HTMLParagraphElement,
  storyList: document.getElementById("story-list") as HTMLDivElement,
  addStory: document.getElementById("add-story") as HTMLButtonElement,
  rebuildStories: document.getElementById("rebuild-stories") as HTMLButtonElement,
  overviewSessions: document.getElementById("overview-sessions") as HTMLDivElement,
  kindRow: document.getElementById("kind-row") as HTMLDivElement,
  docHint: document.getElementById("doc-hint") as HTMLParagraphElement,
  docStatus: document.getElementById("doc-status") as HTMLParagraphElement,
  docTitle: document.getElementById("doc-title") as HTMLInputElement,
  docText: document.getElementById("doc-text") as HTMLTextAreaElement,
  docFile: document.getElementById("doc-file") as HTMLInputElement,
  saveDoc: document.getElementById("save-doc") as HTMLButtonElement,
  sessionTable: document.getElementById("session-table") as HTMLDivElement,
  planGrid: document.getElementById("plan-grid") as HTMLDivElement,
  start: document.getElementById("start-interview") as HTMLButtonElement,
  shortcutList: document.getElementById("shortcut-list") as HTMLDivElement,
  resetShortcuts: document.getElementById("reset-shortcuts") as HTMLButtonElement,
  shortcutStatus: document.getElementById("shortcut-status") as HTMLParagraphElement,
  settingsOpacity: document.getElementById("settings-opacity") as HTMLInputElement,
  settingsOpacityValue: document.getElementById("settings-opacity-value") as HTMLElement,
  settingsSolid: document.getElementById("settings-solid") as HTMLInputElement,
  settingsShareVisible: document.getElementById("settings-share-visible") as HTMLInputElement,
  apiUrl: document.getElementById("api-url") as HTMLInputElement,
  saveApiUrl: document.getElementById("save-api-url") as HTMLButtonElement,
  apiUrlStatus: document.getElementById("api-url-status") as HTMLParagraphElement,
  practiceLede: document.getElementById("practice-lede") as HTMLParagraphElement,
  practiceMeta: document.getElementById("practice-meta") as HTMLParagraphElement,
  practiceStart: document.getElementById("practice-start") as HTMLButtonElement,
  practiceStatus: document.getElementById("practice-status") as HTMLParagraphElement,
  practiceSetup: document.getElementById("practice-setup") as HTMLElement,
  practiceStage: document.getElementById("practice-stage") as HTMLElement,
  practiceProgress: document.getElementById("practice-progress") as HTMLParagraphElement,
  practiceKind: document.getElementById("practice-kind") as HTMLParagraphElement,
  practiceQuestion: document.getElementById("practice-question") as HTMLParagraphElement,
  practiceStory: document.getElementById("practice-story") as HTMLParagraphElement,
  practiceAnswer: document.getElementById("practice-answer") as HTMLDivElement,
  practiceCue: document.getElementById("practice-cue") as HTMLButtonElement,
  practiceProbe: document.getElementById("practice-probe") as HTMLButtonElement,
  practiceNext: document.getElementById("practice-next") as HTMLButtonElement,
  practiceSkip: document.getElementById("practice-skip") as HTMLButtonElement,
  practiceDone: document.getElementById("practice-done") as HTMLElement,
  practiceSummary: document.getElementById("practice-summary") as HTMLParagraphElement,
  practiceAgain: document.getElementById("practice-again") as HTMLButtonElement,
  practiceLive: document.getElementById("practice-live") as HTMLButtonElement,
};

let token = "";
let currentAccount: Account | null = null;
let serverEnvKey = false;

function canUseAi() {
  if (currentAccount?.key.configured) return true;
  return Boolean(serverEnvKey && !window.copilot?.packaged);
}
let kind: DocumentKind = "resume";
let pendingPdf: { name: string; data: string } | null = null;
let latest: Partial<Record<DocumentKind, Doc>> = {};
let stories: Story[] = [];
let storiesState: StoriesStatus | string = "empty";
let storyPoll: number | null = null;
let drill: PracticeQuestion[] = [];
let drillIndex = 0;
let drillPrior: { question: string; kind: string; answer: string }[] = [];
let lastAnswer = "";
let lastKind = "";

function pageFromHash(): Page {
  const raw = location.hash.replace("#", "").split("/")[0];
  return pages.includes(raw as Page) ? (raw as Page) : "overview";
}

function showPage(page: Page) {
  if (location.hash.replace("#", "").split("/")[0] !== page) {
    history.replaceState(null, "", `#${page}`);
  }
  for (const id of pages) {
    const section = document.getElementById(`page-${id}`);
    if (section) section.hidden = id !== page;
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".nav-btn")) {
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

function fillTracks(selected = "auto") {
  $.defaultTrack.replaceChildren();
  for (const track of INTERVIEW_TRACKS) {
    const option = document.createElement("option");
    option.value = track.id;
    option.textContent = track.label;
    $.defaultTrack.append(option);
  }
  $.defaultTrack.value = selected;
}

function fillKinds() {
  $.kindRow.replaceChildren();
  for (const item of DOCUMENT_KINDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    btn.classList.toggle("active", item.id === kind);
    btn.addEventListener("click", () => {
      kind = item.id;
      fillKinds();
      applyDoc();
    });
    $.kindRow.append(btn);
  }
}

function applyDoc() {
  const meta = DOCUMENT_KINDS.find((item) => item.id === kind);
  $.docHint.textContent = meta?.hint ?? "";
  const doc = latest[kind];
  $.docTitle.value = doc?.title ?? "";
  $.docText.value = doc?.text ?? "";
  $.docStatus.textContent = doc
    ? `Saved ${new Date(doc.createdAt).toLocaleString()} · ${doc.chars} characters`
    : "Nothing saved for this type yet.";
  pendingPdf = null;
  $.docFile.value = "";
}

function renderReady(profile: Profile) {
  const items = [
    [Boolean(profile.jobTitle), "Role title"],
    [Boolean(profile.company), "Company"],
    [Boolean(profile.resume), "Resume indexed"],
    [stories.length > 0, stories.length ? `${stories.length} stories` : "Stories"],
    [
      stories.some(storyIsRehearsed),
      stories.some(storyIsRehearsed)
        ? `${stories.filter(storyIsRehearsed).length}/${stories.length} stories rehearsed`
        : "Practice this role",
    ],
    [Boolean(currentAccount?.key.configured || serverEnvKey), "Model key"],
    [Boolean(latest.job), "Job posting"],
    [Boolean(latest.company), "Company notes"],
  ] as const;
  $.readyList.replaceChildren(
    ...items.map(([ok, label]) => {
      const li = document.createElement("li");
      li.textContent = `${ok ? "Ready" : "Missing"} · ${label}`;
      return li;
    }),
  );
  if (profile.resume) {
    $.resumeStatus.textContent = `${profile.resume.title} · ${profile.resume.chunkCount} passages indexed`;
  } else {
    $.resumeStatus.textContent = "No resume yet. Add it under Documents.";
  }
  if (storiesState === "extracting") {
    $.storyStatus.textContent = "Extracting stories from the resume…";
  } else if (stories.length) {
    const ready = stories.filter(storyIsRehearsed).length;
    $.storyStatus.textContent = ready
      ? `${stories.length} stories · ${ready} rehearsed. Live answers prefer those.`
      : `${stories.length} stories ready. Practice them so live pick prefers what you have said.`;
  } else {
    $.storyStatus.textContent = "No stories yet. Add a resume and we will extract them.";
  }
  const role = [profile.jobTitle, profile.company].filter(Boolean).join(" at ");
  $.lede.textContent = role
    ? `Interviewing for ${role}. Start the HUD when you are in the call.`
    : "Add a resume and role so live answers sound like you.";
}

function storyStatusText() {
  if (storiesState === "extracting") return "Extracting stories from your resume…";
  if (storiesState === "error") return "Could not extract stories. Try Rebuild, or add one by hand.";
  if (!stories.length) return "No stories yet. Save a resume, or add one here.";
  const ready = stories.filter(storyIsRehearsed).length;
  return ready
    ? `${stories.length} stories · ${ready} rehearsed. Live answers prefer the ones you practiced.`
    : `${stories.length} stories. Edit a card and save. Practice marks them for live pick.`;
}

function renderStories() {
  $.storiesStatus.textContent = storyStatusText();
  $.rebuildStories.disabled = storiesState === "extracting";
  $.addStory.disabled = storiesState === "extracting";
  if (!stories.length) {
    $.storyList.replaceChildren();
    return;
  }
  $.storyList.replaceChildren(
    ...stories.map((story) => {
      const card = document.createElement("article");
      const rehearsed = storyIsRehearsed(story);
      card.className = rehearsed ? "card story-card rehearsed" : "card story-card";
      const badge = rehearsed
        ? `<span class="rehearsed-badge">Rehearsed${
            story.rehearsalCount ? " · " + story.rehearsalCount : ""
          }</span>`
        : "";
      card.innerHTML = `
        ${badge}
        <label class="field"><span>Name</span><input data-field="name" value="" /></label>
        <label class="field"><span>Tags</span><input data-field="tags" placeholder="conflict, ownership" value="" /></label>
        <label class="field"><span>What happened</span><textarea data-field="situation"></textarea></label>
        <label class="field"><span>What I did</span><textarea data-field="action"></textarea></label>
        <label class="field"><span>Result (allowed facts)</span><textarea data-field="result"></textarea></label>
        <label class="field"><span>Do not invent</span><textarea data-field="forbidden"></textarea></label>
        <div class="story-card-actions">
          <button type="button" data-save>Save</button>
          <button type="button" class="ghost danger" data-delete>Delete</button>
        </div>
        <p class="status" data-msg></p>`;
      const name = card.querySelector<HTMLInputElement>('[data-field="name"]');
      const tags = card.querySelector<HTMLInputElement>('[data-field="tags"]');
      const situation = card.querySelector<HTMLTextAreaElement>('[data-field="situation"]');
      const action = card.querySelector<HTMLTextAreaElement>('[data-field="action"]');
      const result = card.querySelector<HTMLTextAreaElement>('[data-field="result"]');
      const forbidden = card.querySelector<HTMLTextAreaElement>('[data-field="forbidden"]');
      const msg = card.querySelector<HTMLParagraphElement>("[data-msg]");
      if (name) name.value = story.name;
      if (tags) tags.value = story.tags.join(", ");
      if (situation) situation.value = story.situation;
      if (action) action.value = story.action;
      if (result) result.value = story.result;
      if (forbidden) forbidden.value = story.forbidden;
      card.querySelector("[data-save]")?.addEventListener("click", async () => {
        if (!token) return;
        try {
          const saved = await window.copilot.saveStory(token, {
            id: story.id,
            name: sanitizeLine(name?.value ?? "", LIMITS.storyName),
            tags: (tags?.value ?? "")
              .split(",")
              .map((item) => sanitizeLine(item, 40))
              .filter(Boolean),
            situation: sanitizeText(situation?.value ?? "", { max: LIMITS.storyField }),
            action: sanitizeText(action?.value ?? "", { max: LIMITS.storyField }),
            result: sanitizeText(result?.value ?? "", { max: 400 }),
            forbidden: sanitizeText(forbidden?.value ?? "", { max: 320 }),
            signals: story.signals,
          });
          if (saved.error) {
            if (msg) msg.textContent = saved.error;
            return;
          }
          applyStories(saved);
          if (msg) msg.textContent = "Saved.";
        } catch (err) {
          if (msg) msg.textContent = err instanceof Error ? err.message : "Could not save.";
        }
      });
      card.querySelector("[data-delete]")?.addEventListener("click", async () => {
        if (!token) return;
        try {
          applyStories(await window.copilot.deleteStory(token, story.id));
        } catch (err) {
          if (msg) msg.textContent = err instanceof Error ? err.message : "Could not delete.";
        }
      });
      return card;
    }),
  );
}

function currentDrill() {
  return drill[drillIndex];
}

function resetDrillView() {
  $.practiceSetup.hidden = false;
  $.practiceStage.hidden = true;
  $.practiceDone.hidden = true;
}

function renderPracticeMeta() {
  const role = [$.jobTitle.value.trim(), $.jobCompany.value.trim()].filter(Boolean).join(" at ");
  const ready = stories.filter(storyIsRehearsed).length;
  $.practiceLede.textContent = role
    ? `Mock ${role}. Stories you rehearse here are the ones live answers prefer.`
    : "Mock this role. Stories you rehearse here are the ones live answers prefer.";
  if (!stories.length) {
    $.practiceMeta.textContent =
      "Add stories first (or a resume). The drill still covers intro and close.";
  } else if (!ready) {
    $.practiceMeta.textContent = `${stories.length} stories, none rehearsed yet. About 15 minutes.`;
  } else {
    $.practiceMeta.textContent = `${ready}/${stories.length} stories rehearsed. Run it again for the rest.`;
  }
}

function showDrillQuestion() {
  const item = currentDrill();
  if (!item) {
    finishDrill();
    return;
  }
  lastAnswer = "";
  lastKind = item.kind;
  $.practiceSetup.hidden = true;
  $.practiceDone.hidden = true;
  $.practiceStage.hidden = false;
  $.practiceProgress.textContent = `Question ${drillIndex + 1} of ${drill.length}`;
  $.practiceKind.textContent = prettyKind(item.kind);
  $.practiceQuestion.textContent = item.text;
  $.practiceStory.textContent = item.storyName
    ? `Cue this story: ${item.storyName}`
    : "No story lock — speak from the bank if it fits.";
  $.practiceAnswer.textContent =
    "Press Cue card when you want the ladder. Say it out loud first if you can.";
  $.practiceProbe.hidden = !item.probe;
  $.practiceCue.disabled = false;
  $.practiceStatus.textContent = "";
}

function finishDrill() {
  const ready = stories.filter(storyIsRehearsed).length;
  $.practiceStage.hidden = true;
  $.practiceSetup.hidden = true;
  $.practiceDone.hidden = false;
  $.practiceSummary.textContent = ready
    ? `${ready} ${ready === 1 ? "story is" : "stories are"} rehearsed. Live answers will prefer those cards.`
    : "No story was marked. Run the drill again and open a cue card on a story question.";
  renderPracticeMeta();
}

async function loadPracticePlan() {
  if (!token || !window.copilot.practicePlan) return;
  const plan = await window.copilot.practicePlan(token);
  if (plan.error) {
    $.practiceStatus.textContent = plan.error;
    return;
  }
  drill = plan.questions ?? [];
  renderPracticeMeta();
}

async function requestCue(probe = false) {
  const item = currentDrill();
  if (!item || !token) return;
  const question = probe ? item.probe || "Why that choice?" : item.text;
  $.practiceCue.disabled = true;
  $.practiceProbe.disabled = true;
  $.practiceAnswer.textContent = "Writing the ladder…";
  try {
    const result = await window.copilot.practiceTurn(token, {
      question,
      storyId: item.storyId,
      prior: drillPrior,
    });
    if (result.error) {
      $.practiceAnswer.textContent = result.error;
      return;
    }
    lastAnswer = result.answer ?? "";
    lastKind = result.specialist || item.kind;
    $.practiceAnswer.innerHTML = lastAnswer
      ? formatAnswer(lastAnswer)
      : "No answer came back.";
    if (result.stories) applyStories({ stories: result.stories, status: "ready" });
    if (result.story?.name) {
      $.practiceStory.textContent = `Used ${result.story.name}`;
    }
  } catch (err) {
    $.practiceAnswer.textContent =
      err instanceof Error ? err.message : "Could not write a cue card.";
  } finally {
    $.practiceCue.disabled = false;
    $.practiceProbe.disabled = false;
  }
}

function advanceDrill() {
  const item = currentDrill();
  if (item && lastAnswer) {
    drillPrior.push({ question: item.text, kind: lastKind || item.kind, answer: lastAnswer });
  }
  drillIndex += 1;
  showDrillQuestion();
}

function applyStories(payload: {
  stories?: Story[];
  status?: string;
  error?: string;
}) {
  if (payload.error && !payload.stories) {
    $.storiesStatus.textContent = payload.error;
    return;
  }
  stories = payload.stories ?? stories;
  storiesState = payload.status ?? (stories.length ? "ready" : "empty");
  renderStories();
  renderPracticeMeta();
  syncStoryPoll();
}

function syncStoryPoll() {
  if (storiesState === "extracting") {
    if (storyPoll == null) {
      storyPoll = window.setInterval(() => {
        void loadStories();
      }, 2000);
    }
    return;
  }
  if (storyPoll != null) {
    window.clearInterval(storyPoll);
    storyPoll = null;
  }
}

async function loadStories() {
  if (!token || !window.copilot.listStories) return;
  applyStories(await window.copilot.listStories(token));
}

function renderSessions(target: HTMLElement, rows: SessionRow[]) {
  if (!rows.length) {
    target.textContent = "No saved sessions yet.";
    return;
  }
  target.replaceChildren(
    ...rows.map((row) => {
      const el = document.createElement("div");
      el.className = "session-row";
      const when = new Date(row.started_at).toLocaleString();
      const role = [row.job_title, row.company].filter(Boolean).join(" · ");
      el.innerHTML = `<div><strong>${row.status}</strong><span>${when}</span></div>
        <div>${role || "General interview"}${row.meeting_app ? ` · ${row.meeting_app}` : ""}${row.summary ? `<span> · ${row.summary.slice(0, 90)}</span>` : ""}</div>
        <span>${row.transcript_count} turns</span>`;
      return el;
    }),
  );
}

function renderPlan(account: Account) {
  currentAccount = account;
  $.planChip.textContent = account.label;
  const catalog = account.catalog ?? [];
  const cards = catalog
    .map((plan) => {
      const current = account.plan === plan.id && account.status === "active";
      const action = account.stripeEnabled ? "Subscribe" : "Activate locally";
      return `<article class="plan-card ${current ? "current" : ""}">
        <p class="eyebrow">${current ? "Current" : plan.kind === "hosted" ? "Included models" : "Bring a key"}</p>
        <h2>${plan.name}</h2>
        <p class="price">${plan.priceLabel}</p>
        <p class="hint">${plan.blurb}</p>
        <ul>${plan.features.map((item) => `<li>${item}</li>`).join("")}</ul>
        <button type="button" data-subscribe="${plan.id}" ${current ? "disabled" : ""}>
          ${current ? "Your plan" : `${action} · ${plan.priceLabel}`}
        </button>
        <p class="status" data-plan-msg="${plan.id}"></p>
      </article>`;
    })
    .join("");
  const keyHint = account.key.configured
    ? `Saved ${account.key.provider ?? "key"} ending ${account.key.last4}.`
    : "Required to start an interview or practice. Never sent to the overlay.";
  const keyCard = `<article class="plan-card key-card">
      <p class="eyebrow">Model key</p>
      <h2>Your key</h2>
      <p class="hint">${keyHint}</p>
      <label class="field"><span>Provider</span>
        <select id="key-provider">
          <option value="openai">OpenAI</option>
          <option value="claude">Claude</option>
          <option value="groq">Groq</option>
          <option value="compatible">Compatible (custom URL)</option>
        </select>
      </label>
      <label class="field"><span>API key</span>
        <input id="key-value" type="password" autocomplete="off" placeholder="sk-… or sk-ant-…" />
      </label>
      <label class="field"><span>Base URL (optional)</span>
        <input id="key-base" type="url" placeholder="https://api.example.com/v1" />
      </label>
      <div class="story-card-actions">
        <button type="button" id="key-save">Save key</button>
        <button type="button" class="ghost" id="key-clear">Remove key</button>
      </div>
      <p class="hint">Claude writes answers and practice. Live listen needs an OpenAI-compatible key, not a Claude key.</p>
      <p class="status" id="key-status"></p>
    </article>`;
  $.planGrid.innerHTML = cards + keyCard;
  bindPlanActions(account);
}

function bindPlanActions(account: Account) {
  $.planGrid.querySelectorAll<HTMLButtonElement>("[data-subscribe]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const planId = btn.dataset.subscribe;
      if (!planId || !token) return;
      const msg = $.planGrid.querySelector(`[data-plan-msg="${planId}"]`);
      btn.disabled = true;
      if (msg) msg.textContent = account.stripeEnabled ? "Opening Stripe…" : "Activating…";
      try {
        if (account.stripeEnabled && window.copilot.billingCheckout) {
          const result = await window.copilot.billingCheckout(token, planId);
          if (result.error || !result.url) {
            if (msg) msg.textContent = result.error || "Could not start checkout.";
            return;
          }
          await window.copilot.openExternal(result.url);
          if (msg) msg.textContent = "Finish checkout in the browser, then reopen Plan.";
          return;
        }
        const next = await window.copilot.billingActivate(token, planId);
        if (next.error) {
          if (msg) msg.textContent = next.error;
          return;
        }
        renderPlan(next);
      } catch (err) {
        if (msg) msg.textContent = err instanceof Error ? err.message : "Could not subscribe.";
      } finally {
        btn.disabled = false;
      }
    });
  });
  const provider = $.planGrid.querySelector<HTMLSelectElement>("#key-provider");
  const keyValue = $.planGrid.querySelector<HTMLInputElement>("#key-value");
  const keyBase = $.planGrid.querySelector<HTMLInputElement>("#key-base");
  const keyStatus = $.planGrid.querySelector<HTMLParagraphElement>("#key-status");
  if (provider && account.key.provider) provider.value = account.key.provider;
  if (keyBase && account.key.baseUrl) keyBase.value = account.key.baseUrl;
  keyValue?.addEventListener("input", () => {
    const value = keyValue.value.trim();
    if (!provider) return;
    if (value.startsWith("sk-ant-")) provider.value = "claude";
  });
  $.planGrid.querySelector("#key-save")?.addEventListener("click", async () => {
    if (!token) return;
    if (keyStatus) keyStatus.textContent = "Saving…";
    try {
      const next = await window.copilot.billingSaveKey(token, {
        provider: provider?.value,
        apiKey: sanitizeSecret(keyValue?.value ?? ""),
        baseUrl: keyBase?.value,
      });
      if (next.error) {
        if (keyStatus) keyStatus.textContent = next.error;
        return;
      }
      renderPlan(next);
    } catch (err) {
      if (keyStatus) keyStatus.textContent = err instanceof Error ? err.message : "Could not save.";
    }
  });
  $.planGrid.querySelector("#key-clear")?.addEventListener("click", async () => {
    if (!token) return;
    const next = await window.copilot.billingClearKey(token);
    if (!next.error) renderPlan(next);
  });
}

async function loadAll() {
  if (!token) return;
  const [profile, docs, sessions, account, storyPayload] = await Promise.all([
    window.copilot.getProfile(token),
    window.copilot.listDocuments(token),
    window.copilot.listSessions(token),
    window.copilot.getAccount(token),
    window.copilot.listStories(token).catch(() => ({ stories: [] as Story[], status: "empty" })),
  ]);
  applyStories(storyPayload);
  $.jobTitle.value = profile.jobTitle ?? "";
  $.jobCompany.value = profile.company ?? "";
  $.jobRequirements.value = profile.requirements ?? "";
  fillTracks((profile.defaultTrack as InterviewTrackId) || "auto");
  latest = docs.latest ?? {};
  applyDoc();
  currentAccount = account;
  renderPlan(account);
  renderReady(profile);
  renderSessions($.overviewSessions, (sessions.sessions ?? []).slice(0, 4));
  renderSessions($.sessionTable, sessions.sessions ?? []);
  renderPracticeMeta();
  $.lede.textContent =
    account.key.configured || serverEnvKey
      ? "Add a resume and role so live answers sound like you. Start interview opens the HUD."
      : "Add your model key on Plan first. Start interview opens the HUD after that.";
}

document.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page as Page));
});
document.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.go as Page));
});

$.saveRole.addEventListener("click", async () => {
  if (!token) return;
  $.saveRole.disabled = true;
  try {
    await window.copilot.saveProfile(token, {
      jobTitle: sanitizeLine($.jobTitle.value, LIMITS.line),
      company: sanitizeLine($.jobCompany.value, LIMITS.line),
      requirements: sanitizeText($.jobRequirements.value, { max: LIMITS.requirements }),
      defaultTrack: $.defaultTrack.value,
    });
    $.roleStatus.textContent =
      "Role saved. Industry stays here; Auto infers the HUD stage, or override it there.";
    await loadAll();
  } catch (err) {
    $.roleStatus.textContent = err instanceof Error ? err.message : "Could not save role.";
  } finally {
    $.saveRole.disabled = false;
  }
});

$.docFile.addEventListener("change", async () => {
  const file = $.docFile.files?.[0];
  if (!file) return;
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    if (file.size > 8_000_000) {
      pendingPdf = null;
      $.docStatus.textContent = "PDF is too large (max 8 MB).";
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    pendingPdf = { name: file.name, data: bytesToBase64(bytes) };
    $.docText.value = "";
    $.docTitle.value = file.name.replace(/\.pdf$/i, "");
    $.docStatus.textContent = `PDF selected: ${file.name}`;
    return;
  }
  pendingPdf = null;
  $.docText.value = await file.text();
  $.docTitle.value = file.name.replace(/\.[^.]+$/, "");
  $.docStatus.textContent = `Loaded ${file.name}`;
});

$.saveDoc.addEventListener("click", async () => {
  if (!token) return;
  $.saveDoc.disabled = true;
  $.docStatus.textContent = pendingPdf ? `Reading ${pendingPdf.name}…` : "Saving…";
  try {
    const result = await window.copilot.saveDocument(token, {
      kind,
      title: sanitizeLine($.docTitle.value, LIMITS.title) || undefined,
      text: pendingPdf ? undefined : sanitizeText($.docText.value, { max: LIMITS.document }),
      pdfBase64: pendingPdf?.data,
    });
    if (result.error) {
      $.docStatus.textContent = result.error;
      return;
    }
    latest = result.latest ?? latest;
    pendingPdf = null;
    $.docFile.value = "";
    applyDoc();
    await loadAll();
  } catch (err) {
    $.docStatus.textContent = err instanceof Error ? err.message : "Could not save.";
  } finally {
    $.saveDoc.disabled = false;
  }
});

$.addStory.addEventListener("click", async () => {
  if (!token) return;
  $.addStory.disabled = true;
  try {
    applyStories(
      await window.copilot.saveStory(token, {
        name: "New story",
        tags: ["ownership"],
        situation: "What was going on.",
        action: "What I specifically did.",
        result: "The outcome. Numbers only if they are real.",
        forbidden: "Do not invent employers, titles, or metrics.",
        signals: [],
      }),
    );
  } catch (err) {
    $.storiesStatus.textContent = err instanceof Error ? err.message : "Could not add.";
  } finally {
    $.addStory.disabled = false;
  }
});

$.rebuildStories.addEventListener("click", async () => {
  if (!token) return;
  $.rebuildStories.disabled = true;
  $.storiesStatus.textContent = "Rebuilding from the resume…";
  storiesState = "extracting";
  try {
    applyStories(await window.copilot.rebuildStories(token));
  } catch (err) {
    $.storiesStatus.textContent = err instanceof Error ? err.message : "Could not rebuild.";
    storiesState = "error";
  } finally {
    $.rebuildStories.disabled = false;
    syncStoryPoll();
  }
});

$.start.addEventListener("click", () => {
  if (!canUseAi()) {
    showPage("plan");
    const status = document.getElementById("key-status");
    if (status) status.textContent = "Add your model key here before you start.";
    return;
  }
  void window.copilot.showHud();
});

$.practiceStart.addEventListener("click", async () => {
  if (!token) return;
  if (!canUseAi()) {
    showPage("plan");
    const status = document.getElementById("key-status");
    if (status) status.textContent = "Add your model key here before you practice.";
    return;
  }
  $.practiceStart.disabled = true;
  $.practiceStatus.textContent = "Building the loop…";
  try {
    await loadPracticePlan();
    if (!drill.length) {
      $.practiceStatus.textContent = "Could not build a drill. Save a role and try again.";
      return;
    }
    drillIndex = 0;
    drillPrior = [];
    lastAnswer = "";
    showDrillQuestion();
  } catch (err) {
    $.practiceStatus.textContent =
      err instanceof Error ? err.message : "Could not start practice.";
  } finally {
    $.practiceStart.disabled = false;
  }
});

$.practiceCue.addEventListener("click", () => {
  void requestCue(false);
});

$.practiceProbe.addEventListener("click", () => {
  void requestCue(true);
});

$.practiceNext.addEventListener("click", () => advanceDrill());
$.practiceSkip.addEventListener("click", () => {
  lastAnswer = "";
  advanceDrill();
});

$.practiceAgain.addEventListener("click", () => {
  resetDrillView();
  renderPracticeMeta();
});

$.practiceLive.addEventListener("click", () => {
  if (!canUseAi()) {
    showPage("plan");
    const status = document.getElementById("key-status");
    if (status) status.textContent = "Add your model key here before you start.";
    return;
  }
  void window.copilot.showHud();
});

let currentSettings: AppSettings | null = null;
let recording: ShortcutId | null = null;

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
  if ($.settingsOpacityValue) $.settingsOpacityValue.textContent = `${settings.look.opacity}%`;
  $.settingsSolid.checked = settings.look.solidOnHover;
  $.settingsShareVisible.checked = settings.look.shareVisible;
}

async function loadSettings() {
  if (!window.copilot?.getSettings) return;
  const loaded = await window.copilot.getSettings();
  renderShortcuts(loaded.settings);
  if ($.apiUrl) $.apiUrl.value = window.copilot.httpUrl;
}

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
    const result = await window.copilot.saveSettings({
      shortcuts: { [id]: accelerator },
    });
    $.shortcutStatus.textContent = result.ok
      ? `${SHORTCUT_META.find((item) => item.id === id)?.label} is now ${formatAccelerator(accelerator, window.copilot.platform)}.`
      : result.error || "Could not save shortcut.";
    if (result.settings) renderShortcuts(result.settings);
  })();
});

$.resetShortcuts.addEventListener("click", async () => {
  const result = await window.copilot.resetShortcuts();
  $.shortcutStatus.textContent = result.ok
    ? "Shortcuts reset to defaults."
    : result.error || "Could not reset shortcuts.";
  if (result.settings) renderShortcuts(result.settings);
});

$.settingsOpacity.addEventListener("input", () => {
  const opacity = Number($.settingsOpacity.value);
  if ($.settingsOpacityValue) $.settingsOpacityValue.textContent = `${opacity}%`;
  void window.copilot.saveSettings({
    look: { opacity },
  });
});

$.settingsSolid.addEventListener("change", () => {
  void window.copilot.saveSettings({
    look: { solidOnHover: $.settingsSolid.checked },
  });
});

$.settingsShareVisible.addEventListener("change", () => {
  void window.copilot.saveSettings({
    look: { shareVisible: $.settingsShareVisible.checked },
  });
});

$.saveApiUrl?.addEventListener("click", async () => {
  if (!window.copilot.setApiUrl || !$.saveApiUrl || !$.apiUrl) return;
  $.saveApiUrl.disabled = true;
  $.apiUrlStatus.textContent = "Saving…";
  try {
    const result = await window.copilot.setApiUrl($.apiUrl.value);
    if (result.error) {
      $.apiUrlStatus.textContent = result.error;
      return;
    }
    $.apiUrl.value = result.http;
    $.apiUrlStatus.textContent = result.relaunch
      ? "Saved. Relaunching so Home and the HUD use the new API…"
      : "Already using this API.";
  } catch (err) {
    $.apiUrlStatus.textContent = err instanceof Error ? err.message : "Could not save API URL.";
  } finally {
    $.saveApiUrl.disabled = false;
  }
});

window.addEventListener("hashchange", () => showPage(pageFromHash()));

const FALLBACK_ACCOUNT: Account = {
  plan: "free",
  label: "Free",
  status: "free",
  renewsAt: null,
  features: ["Interview HUD", "Resume + role brief", "Session history"],
  stripeEnabled: false,
  key: { configured: false, provider: null, last4: null, baseUrl: null },
  catalog: [
    {
      id: "hosted",
      name: "Hosted AI",
      kind: "hosted",
      priceCents: 3000,
      priceLabel: "$30/mo",
      interval: "month",
      blurb: "Paused for testers. Use your own model key on this page for now.",
      features: ["Interview HUD and story bank", "Hosted models are off while we test", "Add a key below"],
    },
    {
      id: "byok",
      name: "Your key",
      kind: "byok",
      priceCents: 1500,
      priceLabel: "$15/mo",
      interval: "month",
      blurb: "Bring your own model key. We never spend ours on your sessions.",
      features: ["Interview HUD and story bank", "You pay your provider", "OpenAI, Claude, Groq, or compatible"],
    },
  ],
};

async function boot() {
  fillTracks();
  fillKinds();
  renderPlan(FALLBACK_ACCOUNT);
  renderShortcuts(DEFAULT_SETTINGS);
  showPage(pageFromHash());
  applyDoc();
  if (!window.copilot) {
    $.lede.textContent = "Open this dashboard from the Bana Copilot app.";
    return;
  }
  try {
    const auth = await window.copilot.ensureAuth();
    token = auth.token;
    try {
      const health = await fetch(`${window.copilot.httpUrl}/health`).then((r) => r.json());
      serverEnvKey = Boolean(health.ai?.llm) && !window.copilot.packaged;
    } catch {
      serverEnvKey = false;
    }
    await loadAll();
    await loadSettings();
    window.copilot.onProfileChanged(() => {
      void loadAll();
    });
    window.copilot.onSettingsChanged((next) => renderShortcuts(next));
  } catch (err) {
    $.lede.textContent =
      err instanceof Error
        ? err.message
        : "API unavailable. Start Postgres, Redis, and npm run dev:api.";
  }
}

boot();
