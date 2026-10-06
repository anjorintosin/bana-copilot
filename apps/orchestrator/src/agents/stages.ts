import type { InterviewStageId } from "@meeting-copilot/types";
import type { SpecialistId } from "./specialists.js";

export type Stage = {
  id: InterviewStageId;
  label: string;
  /** Specialists this round should prefer. */
  boost: SpecialistId[];
  fallback: SpecialistId;
  /** Extra instruction for the spoken answer this round. */
  style: string;
};

export const STAGES: Record<InterviewStageId, Stage> = {
  auto: {
    id: "auto",
    label: "Auto stage",
    boost: [],
    fallback: "general",
    style: "Detect the round from the question. Do not assume coding or design.",
  },
  intro: {
    id: "intro",
    label: "Intro",
    boost: ["motivation"],
    fallback: "motivation",
    style:
      "This is the opening. Sound like a person, not a resume recitation. Present → past → why this role. Keep career stories ready; do not drop into system design or code unless they asked.",
  },
  behavioral: {
    id: "behavioral",
    label: "Behavioral",
    boost: ["behavioral"],
    fallback: "behavioral",
    style:
      "This is a behavioral round. Tell one STAR story with I-statements and a result. Do not lecture architecture or write code unless they asked for it.",
  },
  technical: {
    id: "technical",
    label: "Technical",
    boost: ["technical"],
    fallback: "technical",
    style:
      "This is a technical-depth round scored like an AI interviewer. Every topic needs a mechanism, a named default you'd ship, the alternative, a failure, and a metric or test. Skip STAR stories unless they asked for one.",
  },
  coding: {
    id: "coding",
    label: "Coding",
    boost: ["coding"],
    fallback: "coding",
    style:
      "This is a live coding round. Approach + Big-O, then a complete fenced solution that does not mutate inputs. Types and a one-line docstring. Name one failing input and the return. Do not give a career story.",
  },
  system_design: {
    id: "system_design",
    label: "System design",
    boost: ["system_design"],
    fallback: "system_design",
    style:
      "This is a system-design round scored like an AI interviewer. Assumed QPS, write API, storage key, the named choice you'd ship, the failure metric. State stays on the request when it can. No textbook definitions.",
  },
  case: {
    id: "case",
    label: "Case / product",
    boost: ["case", "product", "metrics"],
    fallback: "case",
    style:
      "This is a case, product, or metrics round. Structure out loud, use numbers, pick a recommendation. Skip coding unless they asked for SQL.",
  },
  wrap: {
    id: "wrap",
    label: "Close",
    boost: ["motivation"],
    fallback: "motivation",
    style:
      "This is the close. Help with thoughtful questions for them, a tight recap, or next steps. Do not invent a new coding problem.",
  },
};

export function getStage(id?: string): Stage {
  return STAGES[(id as InterviewStageId) ?? "auto"] ?? STAGES.auto;
}
