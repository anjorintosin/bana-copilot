export type SpecialistId =
  | "motivation"
  | "behavioral"
  | "coding"
  | "system_design"
  | "technical"
  | "product"
  | "metrics"
  | "case"
  | "finance"
  | "sales"
  | "design"
  | "general";

export type Specialist = {
  id: SpecialistId;
  label: string;
  /** Phrases that strongly suggest this kind of question. */
  signals: RegExp[];
  /** How this specialist shapes the spoken answer. */
  style: string;
  maxTokens: number;
  temperature: number;
  writesCode?: boolean;
};

export const SPECIALISTS: Record<SpecialistId, Specialist> = {
  motivation: {
    id: "motivation",
    label: "Background & motivation",
    signals: [
      /\btell me about yourself\b/i,
      /\bwalk me through your (resume|background|cv|career)\b/i,
      /\bwhy (do you want|are you interested|this (company|role|team|job)|us\b|should we hire)/i,
      /\bwhy are you (leaving|looking)\b/i,
      /\b(strengths?|weakness(es)?)\b/i,
      /\bwhere do you see yourself\b/i,
      /\b(salary|compensation) expectations?\b/i,
      /\bwhat (motivates|excites) you\b/i,
      /\bany questions for (me|us)\b/i,
    ],
    style: `Background / motivation question.
- "Tell me about yourself": present → past → why this role. 3–5 sentences. Not a skill list.
- "Why us / why this role": one specific thing about the company or role from the notes, tied to one thing from my background.
- Strengths/weaknesses: one real example each; a weakness must include what I'm doing about it.
- "Do you have questions for us?": give 2 thoughtful questions about the team, the role, or something from the company notes.
60–100 words.`,
    maxTokens: 260,
    temperature: 0.55,
  },
  behavioral: {
    id: "behavioral",
    label: "Behavioral (STAR)",
    signals: [
      /\btell me about a time\b/i,
      /\b(give me|share) an example\b/i,
      /\bdescribe a (time|situation)\b/i,
      /\bhave you ever\b/i,
      /\b(conflict|disagree|disagreement|mistake|failure|failed|proud|challenge|difficult|stakeholder|deadline|pressure|feedback|leadership|ownership|influence)\b/i,
    ],
    style: `Behavioral question. Tell one short story in STAR order without the labels: the situation in one sentence, what I did in 2–3 sentences ("I", not "we"), the result with a number if the brief has one, and a one-line lesson.
Use only real facts from the resume, story bank, or claims already made.
If none fit, the bold first line says "**General example (no matching story on file); swap in your own details.**" Then tell a complete, believable story in the same shape: no company names, no made-up numbers (describe the outcome in words), so it is usable as-is and honest.`,
    maxTokens: 380,
    temperature: 0.55,
  },
  coding: {
    id: "coding",
    label: "Coding",
    signals: [
      /\b(write|implement|code up|give me|show me)\b[^.?!]{0,40}\b(function|method|class|algorithm|program|query|script|code|solution)\b/i,
      /\bgiven (an|a) (array|string|list|tree|graph|matrix|integer)\b/i,
      /\b(leetcode|hackerrank|coderpad|two sum|linked list|binary (tree|search)|hash ?map|dynamic programming|recursion|bfs|dfs|sliding window|two pointers?)\b/i,
      /\b(time|space) complexity\b|\bbig o\b/i,
      /\b(offline|dynamic connectivity|union[- ]find|dsu|segment tree|centroid|heavy[- ]light|fenwick|bit tree)\b/i,
      /\b(weighted tree|path weight|count(ing)? (the )?pairs|unordered pairs)\b/i,
      /\breverse (a|the)\b|\bfind the (longest|shortest|maximum|minimum|kth)\b/i,
    ],
    style: `Coding / algorithm problem.
Shape: "Use **<algorithm>** to <goal> in O(...) time" with the reason for the bound in a few words. Then up to 6 steps, one line each, that someone could implement from. Then one line on why it is correct (the invariant, or why each item is counted exactly once). Then the example check. Then the complete, runnable code. Leave the code out only when they ask just for the approach, complexity, or an explanation.
- Example check: trace it only if there are about 10 candidates or fewer (pairs, subarrays, strings to check), and give the result you traced. Larger examples (hundreds of strings, big sums) are not reliable by hand: write "Example: too large to trace by hand; run the code on it." and state no count of your own, even when the stated output looks wrong (then add "the stated output looks inconsistent").
- With code, keep it to at most 4 steps and skip details the code already shows; the code carries the specifics.
- Read the constraints first and pick a structure that meets them; n = 1e5 rules out O(n²).
- Steps name what is easy to forget: the starting or sentinel element, base cases, what is added versus subtracted, and 64-bit totals when counts can reach n².
- Code reads input exactly as specified, handles empty and single-element input, and avoids the classic slips: off-by-one bounds, counting an element with itself, counting a pair twice, revisiting removed or visited nodes.
- A narrow follow-up (complexity, an edge case, "why does this work") gets only that answer, not the whole solution again.`,
    maxTokens: 1400,
    temperature: 0.2,
    writesCode: true,
  },
  system_design: {
    id: "system_design",
    label: "System design",
    signals: [
      /\bdesign (a|an|the)\b/i,
      /\bhow would you (design|build|architect|scale)\b/i,
      /\b(scalab|architecture|distributed|load balanc|shard|replicat|cache|caching|queue|kafka|throughput|latency|cap theorem|consistency|availability|rate limit|cdn|microservice|pagination|cursor pagination|keyset)\w*/i,
    ],
    style: `System design question. Answer like the first two minutes at a whiteboard: judgment, not a textbook. Do not open with a definition.
First line: the design choice in one sentence. Then 3–6 bullets:
1. The requirement that drives the design and the assumed scale (QPS, payload, read/write mix), stated as "assuming…".
2. The data path: write API, what is stored (table, partition key), what is read, the first bottleneck.
3. The choice I would ship (store, cache key + TTL, queue, index) and why for this system.
4. The failure that would hit first (hot shard, stale cache, thundering herd) and the metric that would fire.
5. What changes at 10x.
For a concept question (CAP, consistency, caching), answer by designing a small system around it with named keys, TTLs, and indexes.
A narrow follow-up ("what about 10x?", "why Redis?", "how do you handle that failure?") gets 1–3 sentences, not a new list.`,
    maxTokens: 620,
    temperature: 0.45,
  },
  technical: {
    id: "technical",
    label: "Technical concept",
    signals: [
      /\bwhat is (a|an|the)?\b/i,
      /\b(explain|difference between|how does|how do|what happens when|compare)\b/i,
      /\b(javascript|typescript|python|java|react|node|sql|http|tcp|dns|rest|graphql|docker|kubernetes|aws|oauth|jwt|thread|process|memory|index|transaction|closure|promise|garbage collect|pagination|cursor|offset|keyset)\w*/i,
    ],
    style: `Technical question. The first line answers exactly what was asked. Then 1–3 plain sentences: why, or how it works, plus the one detail worth saying aloud. A definition, a yes/no, a single fact, "what does X evaluate to", or X vs Y between two things stays in sentences.
Use 2–5 numbered points only when the question has several separate parts: a how-to with steps, a comparison of three or more options, or a tooling or design choice where the default, when to pick something else, and a pitfall each matter. Write them as plain sentences, never prefixed with labels like "Mechanism:", "Default:", "Alternative:", "Footgun:", or "Metric:".
For math, probability, or puzzles: set up the equations, solve them, substitute the result back to check, then give the answer first and the working in a sentence or two (steps only if there are several).
Use this level of specificity on whatever was asked (examples, not text to paste):
- Pagination: keyset on (created_at DESC, id DESC) with a matching index and an opaque signed cursor; OFFSET only for admin pages.
- Cache: Redis cache-aside, key user:ID:profile, 60s TTL, singleflight lock on miss; delete the key on write.
- Transactions: the isolation level and the anomaly it blocks, plus the retry on serialization failure.
- HTTP: 429 + Retry-After; Idempotency-Key on POST and what happens on a replay.
If they ask you to write a query or code, put it in one fenced block after the first line, not inline.
If they named a language, stay in it. Never close on "it depends" without naming what I would ship today.`,
    maxTokens: 640,
    temperature: 0.35,
  },
  product: {
    id: "product",
    label: "Product sense",
    signals: [
      /\b(improve|redesign|build a product|design a product|new feature|favorite product|product you love)\b/i,
      /\bhow would you (prioritize|launch|improve|monetize|grow)\b/i,
      /\b(roadmap|prioriti[sz]|user persona|pain points?|go[- ]to[- ]market|mvp|product strategy|north star)\b/i,
    ],
    style: `Product sense / strategy question.
First line: the one solution I would prioritize and for whom. Then bullets: the goal and user, 2–3 pain points, why this solution beats the alternatives, and how I would measure it (one primary metric, one guardrail).`,
    maxTokens: 380,
    temperature: 0.5,
  },
  metrics: {
    id: "metrics",
    label: "Metrics & analytics",
    signals: [
      /\b(metric|kpi|a\/b|ab test|experiment|statistical(ly)?|significance|p[- ]value|confidence interval|regression|sql query|cohort|retention|churn|funnel|conversion|dau|mau)\w*/i,
      /\b(dropped|declined|went down|increased) by\b/i,
      /\bhow would you measure\b/i,
    ],
    style: `Metrics / analytics / experimentation question.
For a metric drop: name the definition, window, and the first cut (internal vs external), then segments (platform, region, cohort, funnel) and the first query and metric (p99, error rate, saturation, conversion).
For "how would you measure": one primary, two supporting, one guardrail — event name or SQL grain, not "engagement".
For stats/SQL: the direct answer first; SQL in a fence. Name sample size, significance, and the peeking footgun if it is an A/B.
80–130 words plus any code.`,
    maxTokens: 450,
    temperature: 0.35,
    writesCode: true,
  },
  case: {
    id: "case",
    label: "Case & estimation",
    signals: [
      /\b(market siz|estimate|how many|guesstimate|back of the envelope)\w*/i,
      /\b(profitab|revenue (is )?(down|declin)|enter (a|the) market|acquisition|acquire|merger|pricing strategy|break[- ]even|case)\w*/i,
      /\bour client\b/i,
    ],
    style: `Case or estimation question. Think out loud like a consultant:
restate the goal in one sentence → lay out a simple MECE structure (2–4 branches) → for estimation, walk the math with round numbers and state each assumption → give a clear answer or the first branch I'd dig into, and a "so what".
Use numbers. 100–150 words.`,
    maxTokens: 420,
    temperature: 0.4,
  },
  finance: {
    id: "finance",
    label: "Finance technical",
    signals: [
      /\b(dcf|discounted cash flow|wacc|ebitda|enterprise value|equity value|valuation|multiples?|lbo|accretion|dilution|three (financial )?statements|balance sheet|income statement|cash flow statement|depreciation|working capital|irr|npv|beta|bond|yield|interest rates?)\b/i,
      /\bpitch (me )?a stock\b/i,
      /\bwalk me through (a|the) (dcf|statements|lbo)\b/i,
    ],
    style: `Finance technical question.
Give the textbook-correct answer first in plain spoken English, then the mechanics step by step (e.g., how a $10 change flows through the three statements), then one sentence on a common pitfall.
Use exact terms (EBITDA, WACC, terminal value). 70–120 words.`,
    maxTokens: 360,
    temperature: 0.3,
  },
  sales: {
    id: "sales",
    label: "Sales & role play",
    signals: [
      /\bsell me\b/i,
      /\b(objection|role ?play|pitch|cold call|discovery call|close the deal|quota|pipeline|prospect|too expensive|not interested|competitor)\w*/i,
      /\bhow would you handle (a|an) (customer|client|prospect)\b/i,
    ],
    style: `Sales question or live role play.
If it's a role play ("sell me…", an objection), respond IN CHARACTER as the seller: acknowledge, ask one discovery question, tie value to their need, propose a next step.
If it's about my sales approach, describe my process with one concrete result (quota %, deal size) from the resume.
50–90 words, warm and confident.`,
    maxTokens: 260,
    temperature: 0.6,
  },
  design: {
    id: "design",
    label: "Design & UX",
    signals: [
      /\b(portfolio|design process|user research|usability|wireframe|prototype|figma|design system|accessibility|critique|heuristic|ux|ui)\b/i,
      /\bwalk me through (a|one of your) (project|design|case study)\b/i,
    ],
    style: `Design / UX question.
Walk the process: the problem and user → research insight → 1–2 key design decisions and the tradeoff → outcome (metric or user feedback).
For a critique: what works, what doesn't, and one concrete change, grounded in a heuristic.
80–120 words.`,
    maxTokens: 320,
    temperature: 0.5,
  },
  general: {
    id: "general",
    label: "General",
    signals: [],
    style: `General chat or interview question.
If they said hello / hi / hey: one casual line, like "hey, what's up? I'm here if you need anything."
Otherwise answer directly in the first sentence, support it with one concrete example from my background if it fits, and finish tying it to this role when it is an interview question.
Greetings: under 20 words. Interview: 50–90 words.`,
    maxTokens: 260,
    temperature: 0.5,
  },
};

export function specialistLabel(id: string) {
  return SPECIALISTS[id as SpecialistId]?.label ?? "Interview";
}
