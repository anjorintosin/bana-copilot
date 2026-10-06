/**
 * Answer-quality eval: runs real questions through the live answer path and scores
 * correctness (code vs brute force, known facts, LLM grader) and overlay format.
 *
 *   npm run eval:answers -w @meeting-copilot/orchestrator -- [--runs 2] [--only tree,lis]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { routeQuestion } from "../agents/router.js";
import { collectAnswer, resolveSpecialist } from "../engine.js";
import { completeChat } from "../llm/chat.js";
import { models } from "../llm/client.js";
import { KNOWLEDGE_IN_BRIEF, assistScreenAsk, formatCandidateBrief } from "../llm/prompts.js";
import { chunkKnowledge } from "../modeKnowledge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "../../../../.env") });
const CHECKER = join(HERE, "coding_checks.py");
const WORK = mkdtempSync(join(tmpdir(), "bana-eval-"));

type Case = {
  id: string;
  kind: "screen" | "typed";
  /** Screen text (screen turns) or the typed question. */
  prompt: string;
  /** Python checker id; the answer must include runnable code. */
  checker?: string;
  /** Regexes the answer must match (algorithm name, key fact). */
  must?: RegExp[];
  /** Regexes the answer must not match. */
  mustNot?: RegExp[];
  /** Stated example output on screen, and whether it is actually correct. */
  stated?: { value: number; correct: boolean; truth: number };
  /** Ask an LLM grader for correctness (non-code answers). */
  judge?: boolean;
  /** What was said aloud before Assist on a screen turn. */
  said?: string;
  /** A user mode whose instructions or knowledge the answer must use. */
  mode?: { name: string; instructions?: string; knowledge?: string };
  /** A simple question: the answer should be sentences, not a numbered list. */
  prose?: boolean;
};

const HANDBOOK = [
  "PTO is unlimited with a 15 day minimum; book it in the HR portal two weeks ahead.",
  "Laptops refresh every three years; request a new one through the IT desk queue.",
  "Design reviews happen Thursdays; post the doc in the architecture channel by Tuesday.",
  "We deploy Monday through Thursday only; Friday deploys need a director sign-off.",
  "Code review needs two approvals for anything touching the shared libraries.",
  "The office is open 8am to 8pm; badge in at the side entrance after hours.",
  "Expense meals under 40 dollars without a receipt; above that attach one.",
  "Quarterly planning starts in week 10; teams submit their roadmap drafts by week 11.",
]
  .map((line, i) => `Section ${i + 1}. ${line} Ask your manager if anything here is unclear.`)
  .join("\n\n");
const LONG_DOC = (fact: string) =>
  `### Engineering handbook\n${Array.from({ length: 12 }, () => HANDBOOK).join("\n\n")}\n\n${fact}\n\n${Array.from({ length: 12 }, () => HANDBOOK).join("\n\n")}`;

const IO = "Read from stdin and print the answer to stdout.";

const CASES: Case[] = [
  {
    id: "tree",
    kind: "screen",
    checker: "tree_pairs",
    prompt: `Counting Close Pairs in a Tree. Given a weighted tree with n nodes (1..n) and integer K, count unordered pairs (u, v) whose path weight is at most K.
Input: "n K", then n-1 lines "u v w". ${IO}
Constraints: n ≤ 100000, w ≤ 1e9, K ≤ 1e15. Aim for O(n log² n).
Example: n=5, K=3, edges 1-2 (1), 1-3 (2), 3-4 (3), 3-5 (1). Output: 6.
Send me your solution in Python.`,
    must: [/centroid/i],
    stated: { value: 6, correct: true, truth: 6 },
  },
  {
    id: "safe",
    kind: "screen",
    checker: "safe_strings",
    prompt: `Counting Safe Strings. Count strings t of length L over 'a'..'z' with t ≤ s lexicographically that contain no forbidden word as a substring, modulo 1e9+7.
Input: "L s", then m, then m forbidden words. ${IO}
Constraints: L ≤ 1000, total forbidden length ≤ 1000.
Example: L=3, s="bca", forbidden ["ab","cc"]. Output: 22.
Send me your solution in Python.`,
    must: [/aho|automaton/i],
    stated: { value: 22, correct: false, truth: 700 },
  },
  {
    id: "subarray",
    kind: "screen",
    checker: "subarray_k",
    prompt: `Subarrays With Sum K. Given n integers (can be negative) and K, count contiguous subarrays whose sum is exactly K.
Input: "n K", then n integers. ${IO}
Constraints: n ≤ 200000, |a_i| ≤ 1e9.
Example: K=2, a=[1, 2, 1, -1, 2, 0]. Output: 6.
Write the code in Python.`,
    must: [/prefix/i],
    stated: { value: 6, correct: true, truth: 6 },
  },
  {
    id: "lis",
    kind: "screen",
    checker: "lis",
    prompt: `Longest Increasing Subsequence. Given n integers, return the length of the longest strictly increasing subsequence.
Input: n, then n integers. ${IO}
Constraints: n ≤ 200000. O(n²) is too slow.
Example: [3, 1, 4, 1, 5, 9, 2, 6]. Output: 4.`,
    must: [/binary search|bisect|patience|tails/i],
    stated: { value: 4, correct: true, truth: 4 },
  },
  {
    id: "distinct",
    kind: "screen",
    checker: "distinct_substrings",
    prompt: `Distinct Substrings. Given a lowercase string s, count its distinct non-empty substrings.
Input: s on one line. ${IO}
Constraints: |s| ≤ 100000.
Example: s = "abab". Output: 7.`,
    must: [/suffix (automaton|array)|sam\b|lcp/i],
    stated: { value: 7, correct: true, truth: 7 },
  },
  {
    id: "strictcost",
    kind: "screen",
    checker: "strict_cost",
    prompt: `Make It Strictly Increasing. Given n integers, in one operation add or subtract 1 from any element. Return the minimum number of operations to make the array strictly increasing.
Input: n, then n integers. ${IO}
Constraints: n ≤ 200000, |a_i| ≤ 1e9.
Example: [2, 1, 5, 3]. Output: 5.
Send me your solution in Python.`,
    must: [/heap|slope|median|isotonic/i],
    stated: { value: 5, correct: true, truth: 5 },
  },
  {
    id: "inversions-explain",
    kind: "screen",
    prompt: `Count Inversions. Given n integers, count pairs i < j with a[i] > a[j].
Constraints: n ≤ 200000.
Example: [3, 1, 2, 5, 4]. Output: 3.
How would you approach this?`,
    must: [/merge sort|fenwick|binary indexed|BIT\b/i],
    mustNot: [/```/],
    stated: { value: 3, correct: true, truth: 3 },
  },
  {
    id: "tree-accepted",
    kind: "screen",
    checker: "tree_pairs",
    prompt: `Counting Close Pairs in a Tree. Given a weighted tree with n nodes (1..n) and integer K, count unordered pairs (u, v) whose path weight is at most K.
Input: "n K", then n-1 lines "u v w". ${IO}
Constraints: n ≤ 100000. Aim for O(n log² n).
Example: n=5, K=3, edges 1-2 (1), 1-3 (2), 3-4 (3), 3-5 (1). Output: 6.

Candidate: Use centroid decomposition with two pointers in O(n log² n): pick a centroid, collect distances, add pairs in the combined list, subtract same-subtree pairs, recurse.

Interviewer: The approach is right. Nitpick: say explicitly that the per-child lists must not include the centroid's 0. If you turn this into code, send it over and I'll check the two-pointer loop and the removed-node handling.`,
    must: [/centroid/i],
  },
  {
    id: "tree-rejected",
    kind: "screen",
    prompt: `Counting Close Pairs in a Tree. Given a weighted tree with n nodes and integer K, count unordered pairs whose path weight is at most K.
Constraints: n ≤ 100000. Aim for O(n log² n).

Candidate: Run a DFS from every node and count nodes within K. O(n) per node.

Interviewer: No, that's O(n²) and too slow for n = 100000. Try again.`,
    must: [/centroid/i],
    mustNot: [/dfs from every node/i],
  },
  {
    id: "typed-two-sum",
    kind: "typed",
    prompt: "Given an array of integers and a target, return the indices of the two numbers that add up to the target.",
    must: [/```/, /hash|dict|map/i],
  },
  {
    id: "coinflips",
    kind: "typed",
    prompt: "What's the expected number of fair coin flips until you get two heads in a row?",
    must: [/\b6\b/],
  },
  {
    id: "aces",
    kind: "typed",
    prompt: "If you draw two cards from a standard deck without replacement, what's the probability both are aces?",
    must: [/1\s*\/\s*221|0\.0045/],
    prose: true,
  },
  {
    id: "js-coercion",
    kind: "typed",
    prompt: "In JavaScript, what does [] + {} evaluate to, and why?",
    must: [/\[object Object\]/],
    prose: true,
  },
  {
    id: "thread-process",
    kind: "typed",
    prompt: "What's the difference between a process and a thread?",
    judge: true,
    prose: true,
  },
  {
    id: "rate-limiter",
    kind: "typed",
    prompt: "How would you design a rate limiter for a public API?",
    judge: true,
  },
  {
    id: "behavioral-no-resume",
    kind: "typed",
    prompt: "Tell me about a time you disagreed with a teammate.",
    judge: true,
    prose: true,
  },
  {
    id: "sql-second-highest",
    kind: "typed",
    prompt: "Write a SQL query to get the second highest salary from an employees table.",
    must: [/```/, /(dense_rank|rank\(\)|offset\s+1|limit\s+1\s*,\s*1|max\([\s\S]*?\)[\s\S]*?<|<\s*\(\s*select\s+max)/i],
  },
  {
    id: "mode-fact-typed",
    kind: "typed",
    prompt: "How does our webhook ingestion handle failures?",
    mode: {
      name: "Acme onsite",
      knowledge: LONG_DOC(
        "Webhook ingestion (the Zephyr service) retries a failed webhook 7 times with exponential backoff starting at 250 ms, then writes it to the dead-letter topic zephyr.dlq, which on-call replays with the zephyr-replay CLI.",
      ),
    },
    must: [/\b7\b/, /250\s?ms/i, /zephyr\.dlq/i],
    prose: true,
  },
  {
    id: "mode-fact-screen",
    kind: "screen",
    prompt:
      "Interviewer (chat): Quick one before we start coding: which topic do order events go to on our side, and what is it partitioned by?",
    mode: {
      name: "Acme onsite",
      knowledge: LONG_DOC(
        "Order events are published to the Kafka topic orders.v2 with 48 partitions, keyed by merchant_id so each merchant's events stay ordered.",
      ),
    },
    must: [/orders\.v2/, /merchant_id/],
  },
  {
    id: "mode-instruction-screen",
    kind: "screen",
    prompt:
      "Two Sum. Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target. Exactly one solution exists. Example: nums = [2,7,11,15], target = 9 → [0,1].",
    mode: {
      name: "Go backend loop",
      instructions: "I'm interviewing for a Go backend role.\nAlways write code in Go, never Python.",
    },
    must: [/```go\b/i],
    mustNot: [/```python/i],
  },
  {
    id: "mode-instruction-typed",
    kind: "typed",
    prompt: "Write a function that checks whether a string is a palindrome, ignoring case and non-letters.",
    mode: {
      name: "Android interview",
      instructions: "Android engineer interview at a fintech. My main language is Kotlin; write all code in Kotlin.",
    },
    must: [/```kotlin\b/i],
  },
  {
    id: "said-constraint-screen",
    kind: "screen",
    prompt: `Longest Increasing Subsequence. Given n integers, return the length of the longest strictly increasing subsequence.
Example: [3, 1, 4, 1, 5, 9, 2, 6]. Output: 4.`,
    said: "Interviewer: Okay, I've shared a problem. Please write your solution in Java for this one. You can assume the array has at most a thousand elements, so a simple quadratic DP is totally fine.",
    must: [/```java\b/i, /dp\[|O\(n²\)|O\(n\^2\)|quadratic/i],
  },
  {
    id: "said-question-beats-screen",
    kind: "screen",
    prompt: `Two Sum. Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target.
Example: nums = [2,7,11,15], target = 9 → [0,1].`,
    said: "Interviewer: Great, that solution works. Before we move on, what's the time and space complexity of the hash map approach, and could you do it in constant extra space if the array were sorted?",
    must: [/O\(n\)/, /two pointers?|two-pointer/i, /O\(1\)/],
  },
  {
    id: "what-is-typescript",
    kind: "typed",
    prompt: "what is typescript",
    judge: true,
    prose: true,
  },
  {
    id: "yes-no-typing",
    kind: "typed",
    prompt: "Is Python statically typed?",
    must: [/dynamic/i],
    prose: true,
  },
  {
    id: "why-company",
    kind: "typed",
    prompt: "Why do you want to work here?",
    mode: {
      name: "Acme onsite",
      instructions: "Interview at Acme, a logistics company. They value owning the outcome. I have backend experience with high-volume event data.",
    },
    must: [/acme|logistic/i],
    prose: true,
  },
  {
    id: "mode-blend",
    kind: "typed",
    prompt: "How would you make order processing idempotent?",
    mode: {
      name: "ShopCo backend",
      instructions:
        "Backend interview at ShopCo.\nOur stack: Go services, Postgres 16, Kafka. Order events are on topic orders.v2, keyed by merchant_id, consumed at least once.",
    },
    must: [/orders\.v2|kafka/i, /idempoten/i, /(unique|upsert|on conflict|dedup)/i],
  },
  {
    id: "mode-general-fallback",
    kind: "typed",
    prompt: "What's the difference between a process and a thread?",
    mode: {
      name: "Acme onsite",
      knowledge: LONG_DOC("Webhook ingestion (the Zephyr service) retries a failed webhook 7 times."),
    },
    judge: true,
    mustNot: [/(not (mentioned|covered)|isn'?t (mentioned|covered)|(doesn'?t|does not) (mention|cover)|no information|in (the|your) (files|knowledge|context))/i],
  },
];

function proseOf(text: string) {
  return text.split("```")[0];
}

function formatIssues(text: string, allowCode: boolean) {
  const issues: string[] = [];
  const outside = text.split("```").filter((_, i) => i % 2 === 0).join("\n");
  const first = text.trim().split("\n")[0] ?? "";
  if (!/\*\*[^*]+\*\*/.test(first)) issues.push("first line has no bold lead");
  if (/^#{1,6}\s/m.test(outside)) issues.push("markdown heading");
  if (/\$[^$\n]+\$|\\\(|\\frac|\\log/.test(outside)) issues.push("LaTeX");
  if (/[\w)\]]\s?\*\s?[\w(]/.test(outside.replace(/\*\*[^*]+\*\*/g, ""))) issues.push("* used for multiplication");
  if (/\b(SAY|PUSH|TRAP)\b:?/.test(outside)) issues.push("ladder labels");
  if (/^\s*(\d+[.)]|[-*•])\s*\**(Mechanism|Default( I'?d ship)?|Alternative|Failure(\/footgun)?|Footgun|Metric(\/test)?)\**\s*:/im.test(outside)) {
    issues.push("template labels on points");
  }
  const words = proseOf(text).split(/\s+/).filter(Boolean).length;
  if (words > 190) issues.push(`${words} words before code`);
  if (!allowCode && text.includes("```")) issues.push("code when not asked");
  return issues;
}

function exampleIssues(text: string, stated?: Case["stated"]) {
  if (!stated) return [];
  const prose = proseOf(text);
  const issues: string[] = [];
  const disputes = /(looks? (off|wrong)|is wrong|incorrect|should be|mismatch|typo)/i.test(prose);
  if (stated.correct && disputes) issues.push(`disputes a correct stated output (${stated.value})`);
  const exampleLines = prose
    .split("\n")
    .filter((line) => /example|sample|stated/i.test(line))
    .join("\n");
  const claims = [
    ...exampleLines.matchAll(/\b(?:I get|(?:count|answer|result|output|total) (?:is|=|should be|would be)|so (?:the )?(?:output|answer|count) is|gives?)\s*\**(\d{1,7})\**\b/gi),
  ].map((m) => Number(m[1]));
  for (const n of new Set(claims)) {
    if (n !== stated.truth) issues.push(`claims example result ${n} (true answer ${stated.truth})`);
  }
  return issues;
}

function runChecker(caseId: string, checker: string, text: string) {
  const code = text.match(/```(?:python|py|python3)?\s*\n([\s\S]*?)```/i)?.[1];
  if (!code) return { ok: false, detail: "no Python code block" };
  const file = join(WORK, `${caseId}-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, code);
  try {
    const out = execFileSync("python3", [CHECKER, checker, file], { encoding: "utf8", timeout: 240_000 });
    return JSON.parse(out.trim().split("\n").pop() || "{}") as { ok: boolean; detail: string };
  } catch (err) {
    return { ok: false, detail: `checker crashed: ${String(err).slice(0, 200)}` };
  }
}

async function judge(question: string, answer: string) {
  const raw = await completeChat({
    system:
      "You grade answers from a live interview copilot. The candidate has no resume on file, so a behavioral answer must not invent employers or metrics and should say it is a general example. Return JSON {\"correct\": boolean, \"score\": 1-5, \"issue\": string}. correct=false for any factual error, invented personal facts, or not answering the question.",
    user: `Question: ${question}\n\nAnswer:\n${answer}`,
    model: models().smart,
    temperature: 0,
    maxTokens: 300,
    json: true,
  });
  try {
    return JSON.parse(raw) as { correct: boolean; score: number; issue: string };
  } catch {
    return { correct: false, score: 0, issue: `grader returned: ${raw.slice(0, 120)}` };
  }
}

async function runCase(item: Case, run: number) {
  const knowledgeText = item.mode?.knowledge ?? "";
  const brief = formatCandidateBrief({
    modeName: item.mode?.name,
    modeInstructions: item.mode?.instructions,
    modeKnowledge: knowledgeText,
  });
  const knowledge = knowledgeText.length > KNOWLEDGE_IN_BRIEF ? chunkKnowledge(knowledgeText) : [];
  const started = Date.now();
  const result =
    item.kind === "screen"
      ? await collectAnswer({
          question: assistScreenAsk(item.said),
          specialist: resolveSpecialist("coding"),
          track: "software",
          brief,
          knowledge,
          prior: [],
          screenContext: item.prompt,
          groundToScreen: true,
        })
      : await collectAnswer({
          question: item.prompt,
          specialist: routeQuestion(item.prompt, "software"),
          track: "software",
          brief,
          knowledge,
          prior: [],
        });
  const text = result.text;
  const failures: string[] = [];
  for (const re of item.must ?? []) if (!re.test(text)) failures.push(`missing ${re}`);
  for (const re of item.mustNot ?? []) if (re.test(text)) failures.push(`has ${re}`);
  failures.push(...exampleIssues(text, item.stated));
  if (item.checker) {
    const check = runChecker(item.id, item.checker, text);
    if (!check.ok) failures.push(`code: ${check.detail}`);
  }
  if (item.judge) {
    const grade = await judge(item.prompt, text);
    if (!grade.correct) failures.push(`grader: ${grade.issue}`);
  }
  const allowCode = Boolean(item.checker) || item.id.startsWith("sql") || item.id.startsWith("typed-") || item.id.startsWith("mode-instruction") || item.id === "said-constraint-screen" || item.id === "tree-rejected";
  const format = formatIssues(text, allowCode);
  if (item.prose && /^\s*\d+[.)]\s/m.test(proseOf(text))) format.push("numbered list on a simple question");
  return {
    id: item.id,
    run,
    agent: result.agent,
    ms: Date.now() - started,
    ttftMs: result.ttftMs,
    correct: failures.length === 0,
    failures,
    format,
    text,
  };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        out.push(await fn(item));
      }
    }),
  );
  return out;
}

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 1;
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const verbose = args.includes("--verbose");
const selected = CASES.filter((c) => !only || only.has(c.id));
const jobs = selected.flatMap((item) => Array.from({ length: runs }, (_, i) => ({ item, run: i + 1 })));

const results = await pool(jobs, 6, ({ item, run }) =>
  runCase(item, run).catch((err) => ({
    id: item.id,
    run,
    agent: "?",
    ms: 0,
    ttftMs: 0,
    correct: false,
    failures: [`error: ${err instanceof Error ? err.message : String(err)}`],
    format: [] as string[],
    text: "",
  })),
);
results.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);

for (const r of results) {
  const mark = r.correct ? "PASS" : "FAIL";
  const fmt = r.format.length ? ` | format: ${r.format.join("; ")}` : "";
  console.log(`${mark} ${r.id}#${r.run} (${r.agent}, ${(r.ms / 1000).toFixed(1)}s, first token ${(r.ttftMs / 1000).toFixed(1)}s)${r.failures.length ? ` | ${r.failures.join("; ")}` : ""}${fmt}`);
  if (verbose || !r.correct) console.log(`    ${proseOf(r.text).trim().replace(/\n/g, "\n    ").slice(0, 900)}`);
}
const correct = results.filter((r) => r.correct).length;
const clean = results.filter((r) => r.format.length === 0).length;
const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length) / 1000).toFixed(1);
console.log(
  `\nCorrect ${correct}/${results.length} · clean format ${clean}/${results.length} · avg total ${avg(results.map((r) => r.ms))}s · avg first token ${avg(results.map((r) => r.ttftMs))}s`,
);
