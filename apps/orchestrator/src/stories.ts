import {
  LIMITS,
  sanitizeLine,
  sanitizeText,
  storyIsRehearsed,
  type Story,
} from "@meeting-copilot/types";
import { completeChat } from "./llm/chat.js";
import { currentAi, models } from "./llm/client.js";

export type StoryDraft = Omit<Story, "id" | "rehearsedAt" | "rehearsalCount">;

const STOP = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "about",
  "tell",
  "time",
  "with",
  "that",
  "this",
  "have",
  "what",
  "when",
  "how",
  "was",
  "were",
  "did",
  "from",
  "into",
  "would",
  "could",
  "should",
  "them",
  "they",
  "their",
  "been",
  "just",
  "like",
  "some",
  "more",
  "than",
  "then",
]);

const STORY_SPECIALISTS = new Set([
  "behavioral",
  "motivation",
  "system_design",
  "design",
  "sales",
  "general",
]);

export function specialistNeedsStory(id: string) {
  return STORY_SPECIALISTS.has(id);
}

function tokens(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

export function scoreStory(question: string, story: Story): number {
  const q = new Set(tokens(question));
  if (!q.size) return 0;
  let score = 0;
  for (const tag of story.tags) {
    if (q.has(tag.toLowerCase())) score += 3;
  }
  for (const word of tokens(story.name)) {
    if (q.has(word)) score += 2;
  }
  for (const signal of story.signals) {
    for (const word of tokens(signal)) {
      if (q.has(word)) score += 2;
    }
  }
  let overlap = 0;
  for (const word of tokens(`${story.situation} ${story.action} ${story.result}`)) {
    if (q.has(word)) overlap += 1;
  }
  score += Math.min(overlap, 4);
  return score;
}

function pickBest(question: string, stories: Story[]): Story | null {
  let best: Story | null = null;
  let bestScore = 0;
  for (const story of stories) {
    const score = scoreStory(question, story);
    if (score > bestScore) {
      best = story;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

/** Local pick — no embed, no model. Prefers rehearsed stories. */
export function pickStory(question: string, stories: Story[]): Story | null {
  if (!stories.length) return null;
  const rehearsed = stories.filter(storyIsRehearsed);
  const fromBank = pickBest(question, rehearsed.length ? rehearsed : stories);
  if (fromBank) return fromBank;
  if (rehearsed.length) return pickBest(question, stories);
  return null;
}

export function formatStory(story: Story) {
  return [
    `Use this story only — ${story.name}`,
    story.tags.length ? `Tags: ${story.tags.join(", ")}` : "",
    story.situation ? `What happened: ${story.situation}` : "",
    story.action ? `What I did: ${story.action}` : "",
    story.result ? `Result (allowed facts): ${story.result}` : "",
    story.forbidden ? `Do not invent: ${story.forbidden}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatStoryCatalog(stories: Story[]) {
  if (!stories.length) return "";
  return stories
    .map((story) => {
      const tags = story.tags.length ? ` [${story.tags.join(", ")}]` : "";
      return `- ${story.name}${tags}`;
    })
    .join("\n");
}

const EXTRACT_PROMPT = `Extract interview stories from a resume.

Return JSON: {"stories":[{"name":"","tags":[],"situation":"","action":"","result":"","forbidden":"","signals":[]}]}

Rules:
- 6 to 12 stories. Only facts that appear in the resume.
- name: 2-5 words, like "Payments p99"
- tags: 1-3 from ownership, conflict, failure, leadership, performance, system, collaboration, initiative, customer, learning
- situation: 1 sentence
- action: 1-2 sentences, I-statements
- result: outcome; include a number only if the resume has one
- forbidden: one line of things a model might invent that are NOT in the resume
- signals: 3-8 keywords an interviewer might say
- Skip skill lists and education. Prefer projects, incidents, conflict, results.
- Thin resume → fewer stories. Never invent employers or metrics.`;

function asString(value: unknown, max: number) {
  return sanitizeText(value, { max, multiline: false });
}

function asList(value: unknown) {
  const items = Array.isArray(value)
    ? value.map((item) => asString(item, 40))
    : typeof value === "string"
      ? value.split(/[,/|]/).map((item) => asString(item, 40))
      : [];
  return items.filter(Boolean).slice(0, 8);
}

export function normalizeDraft(raw: unknown): StoryDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const name = sanitizeLine(row.name, LIMITS.storyName);
  const situation = sanitizeText(row.situation, { max: LIMITS.storyField });
  const action = sanitizeText(row.action, { max: LIMITS.storyField });
  const result = sanitizeText(row.result, { max: 400 });
  if (!name || (!situation && !action && !result)) return null;
  return {
    name,
    tags: asList(row.tags).slice(0, 4),
    situation,
    action,
    result,
    forbidden: sanitizeText(row.forbidden, { max: 320 }),
    signals: asList(row.signals),
  };
}

/** Bullet-line fallback when the model is missing or fails. */
export function heuristicStories(resumeText: string): StoryDraft[] {
  const lines = resumeText
    .split(/\n/)
    .map((line) => line.replace(/^[-*•\d.)]+\s+/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 48 && line.length < 280);
  const scored = lines.filter(
    (line) =>
      /\d/.test(line) ||
      /\b(led|built|reduced|improved|launched|owned|designed|shipped|migrated|cut|grew)\b/i.test(
        line,
      ),
  );
  return (scored.length ? scored : lines).slice(0, 8).map((line, i) => {
    const name =
      line
        .split(/\s+/)
        .slice(0, 4)
        .join(" ")
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .trim() || `Story ${i + 1}`;
    return {
      name,
      tags: ["ownership"],
      situation: line,
      action: "",
      result: "",
      forbidden: "Do not invent employers, team size, or metrics not in this line.",
      signals: tokens(line).slice(0, 6),
    };
  });
}

export async function extractStories(resumeText: string): Promise<StoryDraft[]> {
  const fallback = heuristicStories(resumeText);
  if (!currentAi()?.apiKey) return fallback;
  try {
    const raw = await completeChat({
      system: EXTRACT_PROMPT,
      user: resumeText.slice(0, 10_000),
      model: models().nano,
      temperature: 0.2,
      maxTokens: 1600,
      json: true,
    });
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { stories?: unknown };
    const drafts = (Array.isArray(parsed.stories) ? parsed.stories : [])
      .map((item) => normalizeDraft(item))
      .filter((item): item is StoryDraft => Boolean(item))
      .slice(0, 12);
    return drafts.length ? drafts : fallback;
  } catch {
    return fallback;
  }
}
