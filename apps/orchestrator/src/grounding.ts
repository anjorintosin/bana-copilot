import { jevDecide, jevEnabled } from "./llm/jev.js";

export type GroundingFlag = {
  kind: "invented" | "contradicts";
  confidence: number;
};

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

export async function checkGrounding(input: {
  question: string;
  answer: string;
  evidence: string;
}): Promise<GroundingFlag | null> {
  return flagFromScores(await scoreGrounding(input));
}
