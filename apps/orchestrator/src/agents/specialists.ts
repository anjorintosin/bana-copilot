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
    style: `Behavioral question. Answer as a short story using STAR, without saying "situation/task/action/result":
what was going on (1 sentence) → what I specifically did (2–3 sentences, "I", not "we") → the result, with a number if the resume has one → one-line lesson.
Use only real facts from my resume. If none fit, tell a plausible, modest story without naming employers.
SAY is the story. PUSH is the number or what I would do differently. TRAP is starting a second story.`,
    maxTokens: 380,
    temperature: 0.55,
  },
  coding: {
    id: "coding",
    label: "Coding",
    signals: [
      /\b(write|implement|code) (a|an|the)? ?(function|method|class|algorithm|program|query)\b/i,
      /\bgiven (an|a) (array|string|list|tree|graph|matrix|integer)\b/i,
      /\b(leetcode|hackerrank|coderpad|two sum|linked list|binary (tree|search)|hash ?map|dynamic programming|recursion|bfs|dfs|sliding window|two pointers?)\b/i,
      /\b(time|space) complexity\b|\bbig o\b/i,
      /\breverse (a|the)\b|\bfind the (longest|shortest|maximum|minimum|kth)\b/i,
    ],
    style: `Coding question.
Say the approach in 2–3 spoken sentences (idea, then time and space complexity).
Then one complete, indented, runnable fenced code block (5–30 lines) in the language on the screen or that they asked for — editor tab, starter code, or language dropdown. If that is Java, C++, JavaScript, SQL, Go, or anything else, use that language. Never switch to Python (or any other language) unless that is what is on screen.
PUSH is the edge case or follow-up, not more code.
Never write code as prose. Never solve a famous similar problem (not Two Sum if they asked something else).`,
    maxTokens: 700,
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
    style: `System design / architecture question. Speak it like the first two minutes at a whiteboard — judgment, not a textbook.

Do not open with a definition (CAP, "a microservice is…", "sharding means…"). Assume they know the term.

Always hit, out loud:
1. The one requirement that actually drives the design, plus a concrete scale I am assuming (QPS, data size, read/write mix).
2. The data path: who writes, what is stored, what is read, and the one bottleneck I expect first.
3. The choice I would make (DB, cache, queue, consistency) and the reason in this system — not "you could use Redis".
4. The failure I worry about (hot shard, stale cache, split brain, replay) and how I would detect or contain it.
5. What I would build first vs what I would add at 10x.

If they asked a concept (CAP, partitioning, consistency, pagination), answer by designing a small system around it: "In a payments ledger I'd pick X because…"
Use one resume system if it fits. No spec dumps, no component laundry lists.
SAY is the first 15 seconds: scale, path, the one choice. PUSH is trade-offs, failure, and 10x — including cursor vs OFFSET if they asked about paging. TRAP is the definition.`,
    maxTokens: 560,
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
    style: `Technical knowledge question.

SAY is two sentences: the working answer and the default I would ship. Do not restate it. Do not list every option yet.

PUSH is required on compare / architecture / pagination questions. That is the only place for trade-offs.

Pagination / cursors / OFFSET: SAY = I would page with a keyset cursor on the sort key plus a unique id, because OFFSET gets slower and can skip or repeat rows when writes land between pages. PUSH = OFFSET is fine for small admin tables that need jump-to-page; cursors cannot do page numbers; the sort must be unique or rows vanish; keyset vs seek; what breaks if someone sorts on a non-unique created_at.

CAP / consistency / REST vs gRPC / indexes: SAY = the default I would ship in one system. PUSH = the other option, the failure, and when I would switch.

If it is a narrow language/API fact, keep SAY to the fact plus one example. PUSH is one caveat.

Never end on "it depends" without naming the default I would ship. Never put the cursor-vs-offset lecture in SAY.`,
    maxTokens: 400,
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
    style: `Product sense / strategy question. Structure out loud, briefly:
goal and who the user is → 2–3 user pain points → the one solution I'd prioritize and why → how I'd measure success (one primary metric, one guardrail).
Signal structure with spoken transitions ("First…", "The biggest pain is…"), not bullets.
90–140 words.`,
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
For a metric drop: clarify definition and timeframe → split internal vs. external causes → segment (platform, region, cohort, funnel step) → name the first query I'd run.
For "how would you measure": one primary metric, 2 supporting, 1 guardrail, and why.
For stats/SQL: the direct answer first, then the reasoning; put SQL in a fenced code block.
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
    style: `General interview question. Answer directly in the first sentence, support it with one concrete example from my background, and finish with a sentence tying it back to this role.
50–90 words.`,
    maxTokens: 260,
    temperature: 0.5,
  },
};

export function specialistLabel(id: string) {
  return SPECIALISTS[id as SpecialistId]?.label ?? "Interview";
}
