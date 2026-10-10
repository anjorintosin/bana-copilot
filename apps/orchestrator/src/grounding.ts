import { spokenAnswer } from "@meeting-copilot/types";
import { completeChat } from "./llm/chat.js";
import { currentAi, models } from "./llm/client.js";
import { jevDecide, jevEnabled, type JevQuestion } from "./llm/jev.js";

export type GroundingFlag = {
  kind: "invented" | "contradicts";
  confidence: number;
};

export type GroundingFix = { sentence: string; replacement: string };

export type GroundingScores = { invented: number; contradicts: number };

const QUESTIONS = {
  invented: {
    type: "noul" as const,
    instructions:
      "Does the answer present a personal fact about the candidate (an employer, job title, project, team, product they built, metric, number, date, or tool they personally used) that the evidence does not state? General technical knowledge, advice, and examples clearly labelled as general or hypothetical do not count.",
  },
  contradicts: {
    type: "noul" as const,
    instructions:
      "Does the answer contradict the evidence: a candidate fact, a fact from the user's mode or knowledge files, or a claim already made earlier in the interview?",
  },
};

function threshold() {
  const set = Number(process.env.JEV_FLAG_THRESHOLD);
  return set > 0 && set < 1 ? set : 0.7;
}

/** Jev scores how likely the answer invents or contradicts facts in the supplied evidence. */
export async function scoreGrounding(input: {
  question: string;
  answer: string;
  evidence: string;
}): Promise<GroundingScores | null> {
  if (!jevEnabled() || !input.evidence.trim() || !input.answer.trim()) return null;
  const answers = await jevDecide(
    {
      evidence: input.evidence.slice(0, 24_000),
      question: input.question.slice(0, 2000),
      answer: input.answer.replace(/```[\s\S]*?(```|$)/g, "[code]").slice(0, 6000),
    },
    QUESTIONS,
  );
  const invented = answers?.invented;
  const contradicts = answers?.contradicts;
  if (invented?.type !== "noul" || contradicts?.type !== "noul") return null;
  return { invented: invented.noul, contradicts: contradicts.noul };
}

export function flagFromScores(scores: GroundingScores | null): GroundingFlag | null {
  if (!scores) return null;
  const cut = threshold();
  if (scores.contradicts >= cut && scores.contradicts >= scores.invented) {
    return { kind: "contradicts", confidence: scores.contradicts };
  }
  if (scores.invented >= cut) return { kind: "invented", confidence: scores.invented };
  return null;
}

const ANSWER_CHARS = 6000;
const SENTENCES_PER_CALL = 12;
const MAX_REPLACEMENT_WORDS = 40;

/**
 * Sentences from the part of the answer the HUD shows (no TRAP, code blocks, or list markers).
 * Inline markdown stays so the HUD can render each sentence exactly as it renders the answer.
 */
export function answerSentences(answer: string) {
  return spokenAnswer(answer)
    .slice(0, ANSWER_CHARS)
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "").trim())
    .flatMap((line) => line.split(/(?<=[.!?](?:\*\*|`)?)\s+(?=[A-Z0-9"“(*`])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).length >= 4);
}

/** Asks Jev which sentence carries the problem it flagged on the whole answer. */
export async function locateUnsupported(input: {
  answer: string;
  evidence: string;
  kind: GroundingFlag["kind"];
}): Promise<string | null> {
  const sentences = answerSentences(input.answer);
  if (!sentences.length) return null;
  const rule = QUESTIONS[input.kind].instructions.replace(/^Does the answer/, "Does this sentence");
  const context = {
    evidence: input.evidence.slice(0, 24_000),
    answer: spokenAnswer(input.answer).slice(0, ANSWER_CHARS),
  };
  const batches: string[][] = [];
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_CALL) {
    batches.push(sentences.slice(i, i + SENTENCES_PER_CALL));
  }
  const scored = await Promise.all(
    batches.map(async (batch) => {
      const questions: Record<string, JevQuestion> = {};
      batch.forEach((sentence, index) => {
        questions[`s${index}`] = { type: "noul", instructions: `${rule}\nSentence: "${sentence}"` };
      });
      const answers = await jevDecide(context, questions);
      return batch.map((sentence, index) => {
        const hit = answers?.[`s${index}`];
        return { sentence, score: hit?.type === "noul" ? hit.noul : 0 };
      });
    }),
  );
  let best: string | null = null;
  let bestScore = 0.5;
  for (const { sentence, score } of scored.flat()) {
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return best;
}

/** One spoken replacement that keeps the point but only uses facts from the evidence. */
export async function rewriteSentence(input: {
  question: string;
  sentence: string;
  evidence: string;
}): Promise<string> {
  if (!currentAi()?.apiKey) return "";
  try {
    const raw = await completeChat({
      system:
        "You fix one sentence a job candidate is about to say out loud. Rewrite it so every personal fact (employer, title, project, team, number, date, tool) is supported by the evidence. Keep the same point, first person, natural spoken English, at most 25 words. If the evidence supports none of the specific details, keep the point and drop the made-up details. Return only the sentence.",
      user: `Evidence:\n${input.evidence.slice(0, 8000)}\n\nQuestion: ${input.question.slice(0, 400)}\nSentence to fix: ${input.sentence}`,
      model: models().nano,
      temperature: 0.2,
      maxTokens: 90,
    });
    const replacement = raw.trim().replace(/^["“']|["”']$/g, "");
    return replacement.split(/\s+/).length > MAX_REPLACEMENT_WORDS ? "" : replacement;
  } catch {
    return "";
  }
}

export async function fixUnsupported(input: {
  question: string;
  answer: string;
  evidence: string;
  kind: GroundingFlag["kind"];
}): Promise<GroundingFix | null> {
  const sentence = await locateUnsupported(input);
  if (!sentence) return null;
  const replacement = await rewriteSentence({ question: input.question, sentence, evidence: input.evidence });
  if (!replacement || replacement === sentence) return null;
  return { sentence, replacement };
}

export async function checkGrounding(input: {
  question: string;
  answer: string;
  evidence: string;
}): Promise<GroundingFlag | null> {
  return flagFromScores(await scoreGrounding(input));
}
