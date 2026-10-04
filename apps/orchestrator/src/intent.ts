import type { InterviewStageId } from "@meeting-copilot/types";
import { isCheckIn } from "./questions.js";
import { isFollowUpQuestion } from "./claims.js";
import type { SpecialistId } from "./agents/specialists.js";

export type InterviewerIntent =
  | "question"
  | "probe"
  | "check_in"
  | "hint"
  | "feedback"
  | "wrap"
  | "ignore";

const STAGE_SIGNALS: { id: Exclude<InterviewStageId, "auto">; re: RegExp }[] = [
  {
    id: "wrap",
    re: /\b(any questions for (me|us)|that's all (i had|for today|from me)|we'll be in touch|next steps|thanks for (your )?time|wrapping up|we('re| are) out of time)\b/i,
  },
  {
    id: "coding",
    re: /\b(write|implement|function|leetcode|coderpad|hackerrank|linked list|binary (tree|search)|time complexity|big o|sql query)\b/i,
  },
  {
    id: "system_design",
    re: /\b(design (a|an|the)|how would you (design|scale|architect|build)|distributed|load balanc|shard|replicat)\b/i,
  },
  {
    id: "case",
    re: /\b(market siz|guesstimate|how many .+ in|north star|prioriti[sz]e|favorite product|metric (dropped|declined)|our client)\b/i,
  },
  {
    id: "behavioral",
    re: /\b(tell me about a time|give me an example|describe a (time|situation)|have you ever|disagreed|conflict with)\b/i,
  },
  {
    id: "intro",
    re: /\b(tell me about yourself|walk me through your (resume|background|cv)|why (this (role|company|job)|us|here)|why are you (leaving|looking))\b/i,
  },
  {
    id: "technical",
    re: /\b(what is|difference between|how does|how do .+ work|explain|overload|override|compared to)\b/i,
  },
];

const FROM_SPECIALIST: Partial<Record<SpecialistId, Exclude<InterviewStageId, "auto">>> = {
  motivation: "intro",
  behavioral: "behavioral",
  coding: "coding",
  system_design: "system_design",
  technical: "technical",
  case: "case",
  product: "case",
  metrics: "case",
  finance: "case",
  design: "technical",
};

const FEEDBACK =
  /\b(too (textbook|generic|high[- ]level|shallow)|a bit (textbook|generic|shallow)|lacks? depth|can you go deeper|i('d| would) like more|not sure i (buy|follow) that|that's (a bit )?(vague|surface))\b/i;

const HINT =
  /\b(think about|what if you|consider the|maybe start with|have you thought about|hint:|try (looking|thinking) (at|about))\b/i;

const WRAP =
  /\b(any questions for (me|us)|that's all (i had|for today|from me)|we'll be in touch|next steps|thanks for (your )?time|wrapping up)\b/i;

/** One-breath probes that already have an If-they-push line on the card. */
export function isShallowProbe(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (
    /^(why(\s+that)?\??$|tell me more\.?$|go on\.?$|and then\??$|go deeper\.?$|can you expand\??$|say more\.?$|what do you mean\??$)$/i.test(
      t,
    )
  ) {
    return true;
  }
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 4 && /^(why|and|so|how so)\b/i.test(t);
}

export function inferStage(
  text: string,
  specialistId?: string,
): Exclude<InterviewStageId, "auto"> | null {
  for (const row of STAGE_SIGNALS) {
    if (row.re.test(text)) return row.id;
  }
  if (specialistId && FROM_SPECIALIST[specialistId as SpecialistId]) {
    return FROM_SPECIALIST[specialistId as SpecialistId] ?? null;
  }
  return null;
}

export function classifyIntent(
  text: string,
  opts: { hasTurns: boolean },
): InterviewerIntent {
  const t = text.trim();
  if (!t) return "ignore";
  if (isCheckIn(t)) return "check_in";
  if (WRAP.test(t)) return "wrap";
  if (opts.hasTurns && FEEDBACK.test(t)) return "feedback";
  if (opts.hasTurns && HINT.test(t)) return "hint";
  if (opts.hasTurns && (isShallowProbe(t) || isFollowUpQuestion(t))) return "probe";
  return "question";
}

export function effectiveStage(
  selected: InterviewStageId | undefined,
  inferred: InterviewStageId | undefined,
): InterviewStageId {
  if (selected && selected !== "auto") return selected;
  if (inferred && inferred !== "auto") return inferred;
  return "auto";
}

export function intentGuidance(intent?: InterviewerIntent) {
  if (intent === "feedback") {
    return "They pushed back on the last answer as shallow or textbook. Stay in the same story and claims. SAY should be the next layer (choice, failure, 10x). Do not restart.";
  }
  if (intent === "probe") {
    return "This is a follow-up probe. Stay in the same story and claims. Do not start a new example.";
  }
  if (intent === "wrap") {
    return "They are closing. Questions for them, a tight recap, or next steps. No new coding problem.";
  }
  return "";
}
