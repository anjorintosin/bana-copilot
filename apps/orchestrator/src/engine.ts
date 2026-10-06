import { parseLadder } from "@meeting-copilot/types";
import { SPECIALISTS, type Specialist, type SpecialistId } from "./agents/specialists.js";
import { models, pickAnswerModel, type ReasoningEffort } from "./llm/client.js";
import { completeChat, streamChat, type ChatImage } from "./llm/chat.js";
import { getStage } from "./agents/stages.js";
import { intentGuidance, type InterviewerIntent } from "./intent.js";
import { CLASSIFY_PROMPT, buildCachedSystemPrompt } from "./llm/prompts.js";
import { pickKnowledge } from "./modeKnowledge.js";

export type InterviewKind = "behavioral" | "coding" | "system_design" | "other";

export function toSpoken(text: string) {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((chunk) => {
      if (chunk.startsWith("```")) return chunk;
      return chunk
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/^\s*[-*•]\s+/gm, "")
        .replace(/^\s*\d+[.)]\s+/gm, "");
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** SAY + PUSH only — for recap and echo detection. Keeps markers out of memory. */
export function spokenBody(text: string) {
  const ladder = parseLadder(text);
  return [ladder.say, ladder.push].filter(Boolean).join("\n\n").trim() || toSpoken(text);
}

const QUANT = /\b(probability|probabilit|expected (number|value)|odds|how many (ways|times)|combinations?|permutations?|puzzle|riddle|prove|solve for|integral|derivative|modulo|remainder|average speed|percent(age)? (of|change))\b/i;

function heavyEffort(): ReasoningEffort {
  const set = process.env.ANSWER_HEAVY_EFFORT;
  return set === "medium" || set === "none" ? set : "low";
}

/** Algorithms, math, and logic get the smart model with more reasoning; everything else stays fast. */
export function needsDeepReasoning(specialist: Specialist, text: string) {
  return specialist.id === "coding" || QUANT.test(text);
}

export function resolveSpecialist(id: string): Specialist {
  return SPECIALISTS[id as SpecialistId] ?? SPECIALISTS.general;
}

const RAG_AGENTS = new Set<string>([
  "behavioral",
  "motivation",
  "technical",
  "system_design",
  "general",
  "product",
]);

export function specialistNeedsRag(id: string) {
  return RAG_AGENTS.has(id);
}

export async function classifyTurn(text: string): Promise<{
  isQuestion: boolean;
  kind: InterviewKind;
} | null> {
  const raw = await completeChat({
    system: CLASSIFY_PROMPT,
    user: text.slice(0, 400),
    model: models().nano,
    temperature: 0,
    maxTokens: 60,
    json: true,
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { isQuestion?: boolean; kind?: string };
    const kind: InterviewKind =
      parsed.kind === "behavioral" ||
      parsed.kind === "coding" ||
      parsed.kind === "system_design"
        ? parsed.kind
        : "other";
    return { isQuestion: Boolean(parsed.isQuestion), kind };
  } catch {
    return null;
  }
}

export type AnswerTelemetry = {
  agent: string;
  model: string;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export async function* streamAnswer(input: {
  question: string;
  specialist: Specialist;
  track?: string;
  stage?: string;
  brief?: string;
  ragContext?: string;
  prior: { question: string; kind: string; answer: string }[];
  screenContext?: string;
  rollingSummary?: string;
  claims?: string;
  intent?: InterviewerIntent;
  smart?: boolean;
  image?: ChatImage;
  groundToScreen?: boolean;
  maxTokens?: number;
  knowledge?: string[];
}): AsyncGenerator<string, AnswerTelemetry> {
  const specialist = input.specialist;
  const excerpt = pickKnowledge(
    input.knowledge ?? [],
    `${input.question}\n${input.screenContext ?? ""}`,
  );
  const knowledgeBlock = excerpt
    ? `\nFrom their mode's knowledge files (ground truth for whatever they cover; combine with your own expertise for the rest; ignore parts unrelated to the question):\n${excerpt}\n`
    : "";
  const heavy = needsDeepReasoning(specialist, `${input.question}\n${input.groundToScreen ? input.screenContext ?? "" : ""}`);
  const model = pickAnswerModel({
    smart: input.smart || heavy,
    writesCode: specialist.writesCode,
  });
  const started = Date.now();
  let ttftMs = 0;
  let telemetry: AnswerTelemetry = {
    agent: specialist.id,
    model,
    ttftMs: 0,
    totalMs: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
  };

  const prior = input.groundToScreen
    ? ""
    : input.prior
        .slice(-2)
        .map(
          (turn) =>
            `Q (${turn.kind}): ${turn.question}\nA: ${turn.answer.slice(0, 280)}`,
        )
        .join("\n\n");

  const user = input.groundToScreen
    ? `Screen turn: a screenshot is attached, and this is the text read from it.

Screen extract:
${(input.screenContext || "(none)").slice(0, 2400)}
${input.rollingSummary ? `\nInterview so far:\n${input.rollingSummary.slice(0, 400)}\n` : ""}${knowledgeBlock}
They asked:
${input.question}`
    : `Interview stage: ${getStage(input.stage).label}. ${getStage(input.stage).style}

Recent Q&A:
${prior || "(none)"}

Screen:
${(input.screenContext || "(none)").slice(0, 800)}

Picked story (stay inside it; ignore if none):
${(input.ragContext || "(none)").slice(0, 700)}

Interview so far:
${(input.rollingSummary || "(just started)").slice(0, 400)}

Claims already said:
${(input.claims || "(none)").slice(0, 400)}
${knowledgeBlock}${input.image ? "\nA screenshot of their display is attached. If they typed a real question, answer it and use the screenshot as context. If they typed a greeting or nothing useful, answer the question on the screenshot.\n" : ""}
${intentGuidance(input.intent)}

They just asked:
${input.question}`;

  const stream = streamChat({
    system: buildCachedSystemPrompt(input.track, input.brief ?? "", specialist.id),
    user,
    model,
    temperature: specialist.temperature,
    maxTokens: input.maxTokens ?? specialist.maxTokens,
    image: input.image,
    reasoningEffort: heavy ? heavyEffort() : "low",
    verbosity: "low",
  });
  let next = await stream.next();
  while (!next.done) {
    if (!ttftMs) ttftMs = Date.now() - started;
    yield next.value;
    next = await stream.next();
  }
  telemetry.ttftMs = ttftMs;
  telemetry.totalMs = Date.now() - started;
  telemetry.inputTokens = next.value.inputTokens;
  telemetry.outputTokens = next.value.outputTokens;
  console.log("[answer]", JSON.stringify(telemetry));
  return telemetry;
}

export async function collectAnswer(
  input: Parameters<typeof streamAnswer>[0],
): Promise<AnswerTelemetry & { text: string }> {
  const gen = streamAnswer(input);
  let text = "";
  let next = await gen.next();
  while (!next.done) {
    text += next.value;
    next = await gen.next();
  }
  return { ...next.value, text };
}

export async function summarizeInterview(input: {
  turns: { question: string; kind: string; answer: string }[];
  previous?: string;
  job?: { title?: string | null; company?: string | null };
  final?: boolean;
}): Promise<string> {
  if (!input.turns.length && !input.previous) {
    return input.final ? "No questions were captured in this session." : "";
  }
  const qa = input.turns
    .slice(-6)
    .map(
      (turn, i) =>
        `${i + 1}. (${turn.kind}) ${turn.question}\nYou: ${spokenBody(turn.answer).slice(0, 220)}`,
    )
    .join("\n\n");
  return completeChat({
    system: input.final
      ? `Write a post-interview recap for the candidate. Plain language. Short lines, no fluff.
Cover: what they asked, what you covered, what to review later.
80–120 words. No "great job". No markdown headings.`
      : `Update a running interview memory. 60–90 words.
What has been asked so far and the stance the candidate took. No cue cards. No markdown headings.`,
    user: `Role: ${input.job?.title || "the role"} ${input.job?.company ? "at " + input.job.company : ""}
Prior memory:
${input.previous || "(none)"}

Q&A:
${qa || "(none)"}`,
    model: models().nano,
    temperature: 0.3,
    maxTokens: input.final ? 220 : 120,
  });
}

export { formatCandidateBrief, buildCachedSystemPrompt } from "./llm/prompts.js";
export { parseLadder } from "@meeting-copilot/types";
