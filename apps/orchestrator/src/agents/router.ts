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
