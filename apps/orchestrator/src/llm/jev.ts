/**
 * TypeSafe Jev: a non-generative decision model. It answers typed questions about a
 * supplied state with probabilities. Off unless TYPESAFE_API_KEY is set.
 */
const ENDPOINT = process.env.TYPESAFE_API_URL ?? "https://api.typesafe.ai/v1/systemone";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

export function jevEnabled() {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim()) && process.env.JEV_GROUNDING !== "off";
}

export async function jevDecide(
  state: string | Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  timeoutMs = 4000,
): Promise<Record<string, JevAnswer> | null> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.JEV_MODEL ?? "jev-latest", state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[jev] ${res.status} ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const body = (await res.json()) as { answers?: Record<string, JevAnswer> };
    return body.answers ?? null;
  } catch (err) {
    console.warn(`[jev] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
