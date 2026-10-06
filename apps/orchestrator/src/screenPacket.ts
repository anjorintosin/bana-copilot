import type { ScreenAnalysis } from "./llm/vision.js";

export type PackedQuestion = { key: string; text: string };

export type ScreenPacket = {
  title: string;
  language: string;
  passage: string;
  questions: PackedQuestion[];
  answered: string[];
};

export function questionKey(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
}

export function isJunkScreenText(text: string) {
  return /\b(back button|typed helo|don't type [“"]?helo|restart desktop|ask anything|if they push|redux lecture|bana copilot|finished restart|hello \/ helo|reduce the hud)\b/i.test(
    text,
  );
}

export function looksLikeAlgoProblem(text: string) {
  const t = text.toLowerCase();
  if (/\b(constraints?|offline dynamic|segment tree|rollback dsu|union[- ]find)\b/.test(t)) return true;
  if (/\b(1\s*≤|10\^|200,?000|2e5)\b/.test(t) && /\b(add|remove|query|return)\b/.test(t)) return true;
  if (/\badd u v\b/.test(t) && /\bquery u v\b/.test(t)) return true;
  return false;
}

export function mergeScreenPacket(
  prev: ScreenPacket | undefined,
  analysis: ScreenAnalysis,
): { packet: ScreenPacket; fresh: PackedQuestion[] } {
  const passage =
    analysis.passage.length >= 40
      ? analysis.passage
      : prev?.passage || "";
  const incoming = analysis.questions
    .map((text) => ({ key: questionKey(text), text: text.trim() }))
    .filter((item) => item.text.length >= 8);
  const byKey = new Map<string, PackedQuestion>();
  for (const item of prev?.questions ?? []) byKey.set(item.key, item);
  const fresh: PackedQuestion[] = [];
  for (const item of incoming) {
    if (!byKey.has(item.key)) fresh.push(item);
    byKey.set(item.key, item);
  }
  const packet: ScreenPacket = {
    title: analysis.title || prev?.title || "",
    language: analysis.language || prev?.language || "",
    passage,
    questions: [...byKey.values()],
    answered: [...(prev?.answered ?? [])],
  };
  return { packet, fresh };
}

export function markAnswered(packet: ScreenPacket, keys: string[]): ScreenPacket {
  const answered = new Set(packet.answered);
  for (const key of keys) answered.add(key);
  return { ...packet, answered: [...answered] };
}

export function formatPacketPrompt(
  packet: ScreenPacket,
  toAnswer: PackedQuestion[],
  opts: { imageHasQuestions: boolean },
) {
  const numbered = toAnswer
    .map((item, i) => `Q${i + 1}. ${item.text}`)
    .join("\n");
  return [
    packet.title ? `Title: ${packet.title}` : "",
    packet.language ? `Language: ${packet.language}` : "",
    packet.passage
      ? `Statement / passage (use this even if it is scrolled off the current screenshot):\n${packet.passage}`
      : "",
    numbered
      ? `Answer every question below, in order, labeled Q1, Q2, …\n${numbered}`
      : "",
    opts.imageHasQuestions
      ? "The attached screenshot may show only the lower questions. Keep using the statement above."
      : "The attached screenshot may show only the statement. Do not invent questions that are not listed.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function looksLikeCompleteCodingProblem(analysis: ScreenAnalysis) {
  if (analysis.kind !== "code") return false;
  if (analysis.questions.length > 0) return false;
  const body = analysis.problem || analysis.ocrText;
  return body.length >= 40;
}
