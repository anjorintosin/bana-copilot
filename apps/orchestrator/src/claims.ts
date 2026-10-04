import {
  emptyClaims,
  parseLadder,
  type ClaimsLedger,
  type Story,
} from "@meeting-copilot/types";
import { completeChat } from "./llm/chat.js";
import { currentAi, models } from "./llm/client.js";
import { pickStory } from "./stories.js";

function body(text: string) {
  const ladder = parseLadder(text);
  return [ladder.say, ladder.push].filter(Boolean).join("\n\n").trim() || text;
}

const SYSTEMS = [
  "redis",
  "kafka",
  "postgres",
  "postgresql",
  "mysql",
  "dynamodb",
  "s3",
  "react",
  "next",
  "node",
  "fastapi",
  "kubernetes",
  "k8s",
  "docker",
  "graphql",
  "grpc",
  "spark",
  "snowflake",
  "bigquery",
];

const NEW_STORY =
  /\b(tell me about (a |another |a different )?time|another example|different (example|story|situation)|walk me through your (resume|background)|why (this|us|here))\b/i;

/** Short probe that should stay on the last story / facts. */
export function isFollowUpQuestion(question: string) {
  const t = question.trim();
  if (!t || NEW_STORY.test(t)) return false;
  if (
    /^(why|how come|what about|and then|so what|tell me more|go on|who was|which one|can you (expand|say more|go deeper)|what (failed|breaks|happens)|walk me through that|why that|why not)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  const words = t.split(/\s+/).filter(Boolean);
  return (
    words.length <= 12 &&
    /\b(that|this|it|they|them|those|there)\b/i.test(t) &&
    !/\b(write|implement|design a|code )\b/i.test(t)
  );
}

export function pickLockedStory(
  question: string,
  stories: Story[],
  ledger: ClaimsLedger,
): Story | null {
  if (ledger.story && isFollowUpQuestion(question)) {
    const locked = stories.find((story) => story.name === ledger.story);
    if (locked) return locked;
  }
  const picked = pickStory(question, stories);
  if (picked) return picked;
  if (ledger.story) {
    return stories.find((story) => story.name === ledger.story) ?? null;
  }
  return null;
}

function uniq(items: string[], cap: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim();
    if (!key) continue;
    const fold = key.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}

function extractNumbers(text: string) {
  const hits =
    text.match(
      /\b\d+(?:\.\d+)?\s*(?:%|ms|s|x|k|m|bn|percent|people|engineers?|weeks?|days?|months?|years?)?\b|\bp99\b|\bp95\b|\b(?:a|one|two|three)\s+(?:week|day|month|year)s?\b/gi,
    ) ?? [];
  return uniq(
    hits.map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item.length < 24),
    6,
  );
}

function extractSystems(text: string) {
  const lower = text.toLowerCase();
  return uniq(
    SYSTEMS.filter((name) => lower.includes(name)).map((name) =>
      name === "postgresql" ? "Postgres" : name === "k8s" ? "Kubernetes" : name,
    ),
    6,
  );
}

function extractEmployer(text: string, story?: Story | null) {
  const fromStory = `${story?.situation ?? ""} ${story?.action ?? ""} ${story?.result ?? ""}`;
  const at =
    `${fromStory} ${text}`.match(
      /\b(?:[Aa]t|[Ff]rom)\s+([A-Z][A-Za-z0-9&'’]+(?:\s+[A-Z][A-Za-z0-9&'’]+){0,3})/,
    )?.[1];
  if (at && !/^(I|The|This|That|We|My)$/.test(at)) return at.trim();
  return "";
}

function extractPeople(text: string) {
  const roles =
    text.match(
      /\b(?:pm|product manager|manager|intern|junior|staff|principal|director|founder|designer|on-call)\b/gi,
    ) ?? [];
  return uniq(roles, 4);
}

export function mergeClaims(prior: ClaimsLedger, next: Partial<ClaimsLedger>): ClaimsLedger {
  return {
    story: next.story || prior.story,
    employer: next.employer || prior.employer,
    people: uniq([...prior.people, ...(next.people ?? [])], 6),
    numbers: uniq([...prior.numbers, ...(next.numbers ?? [])], 8),
    systems: uniq([...prior.systems, ...(next.systems ?? [])], 8),
    facts: uniq([...(next.facts ?? []), ...prior.facts], 5),
  };
}

/** Instant — no model. Run after an answer so the next question already has a lock. */
export function heuristicClaims(input: {
  answer: string;
  story?: Story | null;
  prior: ClaimsLedger;
}): ClaimsLedger {
  const spoken = body(input.answer);
  const source = `${input.story?.result ?? ""} ${spoken}`;
  return mergeClaims(input.prior, {
    story: input.story?.name ?? "",
    employer: extractEmployer(spoken, input.story),
    people: extractPeople(spoken),
    numbers: extractNumbers(source),
    systems: extractSystems(source),
    facts: spoken
      .split(/\n+/)
      .map((line) => line.replace(/^```[\s\S]*$/, "").trim())
      .filter((line) => line.length > 20 && line.length < 140 && !line.startsWith("```"))
      .slice(0, 2),
  });
}

export async function refineClaims(input: {
  question: string;
  answer: string;
  prior: ClaimsLedger;
  storyName?: string;
}): Promise<ClaimsLedger | null> {
  if (!currentAi()?.apiKey) return null;
  try {
    const raw = await completeChat({
      system: `Extract only facts the candidate already said. Return JSON:
{"story":"","employer":"","people":[],"numbers":[],"systems":[],"facts":[]}
Reuse the prior ledger on a follow-up. Do not invent an employer, headcount, or metric. Empty string/array if unknown.`,
      user: `Prior ledger:
${JSON.stringify(input.prior)}
Story card: ${input.storyName || "(none)"}
Q: ${input.question.slice(0, 280)}
A: ${body(input.answer).slice(0, 700)}`,
      model: models().nano,
      temperature: 0,
      maxTokens: 220,
      json: true,
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClaimsLedger>;
    return mergeClaims(input.prior, {
      story: typeof parsed.story === "string" ? parsed.story : "",
      employer: typeof parsed.employer === "string" ? parsed.employer : "",
      people: Array.isArray(parsed.people) ? parsed.people.map(String) : [],
      numbers: Array.isArray(parsed.numbers) ? parsed.numbers.map(String) : [],
      systems: Array.isArray(parsed.systems) ? parsed.systems.map(String) : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
    });
  } catch {
    return null;
  }
}

export { emptyClaims };
