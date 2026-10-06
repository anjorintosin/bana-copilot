import { getStage } from "./stages.js";
import { SPECIALISTS, type Specialist, type SpecialistId } from "./specialists.js";
import { getTrack } from "./tracks.js";

const PRIORITY: SpecialistId[] = [
  "motivation",
  "behavioral",
  "coding",
  "system_design",
  "case",
  "finance",
  "metrics",
  "product",
  "sales",
  "design",
  "technical",
  "general",
];

/** Broad specialists match many questions, so their signals count for less. */
const WEIGHT: Partial<Record<SpecialistId, number>> = {
  technical: 0.5,
  system_design: 0.8,
  motivation: 1.5,
  behavioral: 1.2,
};

export function scoreSpecialists(text: string, allowed: SpecialistId[]) {
  return allowed
    .map((id) => {
      const spec = SPECIALISTS[id];
      const hits = spec.signals.filter((re) => re.test(text)).length;
      return { id, score: hits * (WEIGHT[id] ?? 1) };
    })
    .sort(
      (a, b) => b.score - a.score || PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id),
    );
}

const LANGUAGE = String.raw`(js|javascript|ts|typescript|python|py|java|kotlin|swift|go|golang|rust|ruby|php|scala|c|c\+\+|cpp|c#|csharp|sql|bash)`;
const FOLLOW_UP = [
  new RegExp(String.raw`^(now |and |ok |okay |can you |could you |please )*(do it |write it |redo it |rewrite it |same |convert it |translate it |show it )?(in|using|with|to) ${LANGUAGE}\b`, "i"),
  new RegExp(String.raw`^${LANGUAGE}( please| version)?[?.!]*$`, "i"),
  /^(more|more again|again|continue|go on|keep going|expand|elaborate|why|how so|example|an example|go deeper|deeper|simpler|shorter|tell me more|say more|explain (that|it|more|again)|what about (that|it)|and then)\b/i,
];

/** Short replies that continue the previous answer ("in js", "more", "why") rather than ask something new. */
export function isFollowUp(text: string) {
  const t = text.trim();
  if (!t || t.split(/\s+/).length > 7) return false;
  return FOLLOW_UP.some((re) => re.test(t));
}

/**
 * Picks the specialist for a question. A model hint wins when it is allowed in
 * this track; otherwise keyword signals decide, then the track fallback.
 */
export function routeQuestion(
  text: string,
  trackId?: string,
  hint?: string,
  stageId?: string,
): Specialist {
  const track = getTrack(trackId);
  const stage = getStage(stageId);
  if (hint && track.specialists.includes(hint as SpecialistId)) {
    return SPECIALISTS[hint as SpecialistId];
  }
  const ranked = scoreSpecialists(text, track.specialists).map((row) => ({
    ...row,
    score: row.score + (stage.boost.includes(row.id) ? 2.5 : 0),
  }));
  ranked.sort(
    (a, b) => b.score - a.score || PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id),
  );
  const [best] = ranked;
  if (best && best.score > 0) return SPECIALISTS[best.id];
  if (stage.id !== "auto" && track.specialists.includes(stage.fallback)) {
    return SPECIALISTS[stage.fallback];
  }
  return SPECIALISTS[track.fallback];
}
