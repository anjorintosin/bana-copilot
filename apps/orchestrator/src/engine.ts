import { parseLadder } from "@meeting-copilot/types";
import { SPECIALISTS, type Specialist, type SpecialistId } from "./agents/specialists.js";
import { models, pickAnswerModel } from "./llm/client.js";
import { completeChat, streamChat, type ChatImage } from "./llm/chat.js";
import { getStage } from "./agents/stages.js";
import { intentGuidance, type InterviewerIntent } from "./intent.js";
import { CLASSIFY_PROMPT, buildCachedSystemPrompt } from "./llm/prompts.js";

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

export function resolveSpecialist(id: string): Specialist {
  return SPECIALISTS[id as SpecialistId] ?? SPECIALISTS.general;
}

const RAG_AGENTS = new Set<string>(["behavioral", "motivation"]);

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
}): AsyncGenerator<string, AnswerTelemetry> {
  const specialist = input.specialist;
  const model = pickAnswerModel({
    smart: input.smart,
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
    ? `This is a solve-on-screen turn. A screenshot is attached — that image is the only question.
Solve ONLY the problem visible in the image. The extract below may be incomplete; if it disagrees with the image, trust the image.
Use the exact programming language in the editor, starter code, or language dropdown. Never switch languages. Never default to Python unless the screen is Python.
Do not reuse a previous interview question. Do not invent a similar LeetCode problem.
If you cannot read the problem, say that in SAY. Do not guess.

Screen extract:
${(input.screenContext || "(none)").slice(0, 1800)}

They asked:
${input.question}

Use the ${specialist.label} style. Gist, then SAY, PUSH, TRAP.`
    : `Specialist: ${specialist.label}
Interview stage: ${getStage(input.stage).label}
Stage guidance: ${getStage(input.stage).style}

Recent Q&A:
${prior || "(none)"}

Screen:
${(input.screenContext || "(none)").slice(0, 800)}

Picked story (stay inside it; ignore if none):
${(input.ragContext || "(none)").slice(0, 700)}

Interview so far:
${(input.rollingSummary || "(just started)").slice(0, 400)}

Claims already said (reuse these; do not invent a new employer, metric, or story):
${(input.claims || "(none)").slice(0, 400)}

They just asked:
${input.question}

${intentGuidance(input.intent)}

Use the ${specialist.label} style. Gist, then SAY, PUSH, TRAP.`;

  const stream = streamChat({
    system: buildCachedSystemPrompt(input.track, input.brief ?? ""),
    user,
    model,
    temperature: specialist.temperature,
    maxTokens: specialist.maxTokens,
    image: input.image,
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
