import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { routeQuestion } from "../agents/router.js";
import { collectAnswer } from "../engine.js";
import { extractLatestQuestion, isQuestionLike } from "../questions.js";
import { TurnAssembler } from "../turns.js";
import { pickStory } from "../stories.js";
import { emptyClaims, parseLadder, type Story } from "@meeting-copilot/types";
import {
  heuristicClaims,
  isFollowUpQuestion,
  pickLockedStory,
} from "../claims.js";
import { classifyIntent, inferStage, isShallowProbe } from "../intent.js";
import { buildPracticePlan } from "../practice.js";
import { FIXTURES, type ReplayCase } from "./fixtures.js";

function checkStoryPick() {
  const stories: Story[] = [
    {
      id: "1",
      name: "Payments p99",
      tags: ["performance", "system"],
      situation: "Checkout timed out at peak",
      action: "I put a cache in front of the ledger",
      result: "p99 800ms to 120ms",
      forbidden: "Do not invent a 12-person team",
      signals: ["latency", "cache", "payments", "timeout"],
    },
    {
      id: "2",
      name: "Stakeholder conflict",
      tags: ["conflict"],
      situation: "PM wanted to ship without tests",
      action: "I pushed back and showed the last incident",
      result: "We delayed a week and caught a payout bug",
      forbidden: "",
      signals: ["disagreed", "conflict", "stakeholder"],
    },
  ];
  const conflict = pickStory(
    "Tell me about a time you disagreed with a stakeholder",
    stories,
  );
  if (conflict?.name !== "Stakeholder conflict") {
    throw new Error(`story pick expected conflict, got ${conflict?.name ?? "none"}`);
  }
  const latency = pickStory("How did you handle a latency incident in payments?", stories);
  if (latency?.name !== "Payments p99") {
    throw new Error(`story pick expected payments, got ${latency?.name ?? "none"}`);
  }
  const coding = pickStory("Write a function that reverses a linked list", stories);
  if (coding) {
    throw new Error(`story pick should skip coding, got ${coding.name}`);
  }

  const rehearsedConflict: Story = {
    ...stories[1],
    rehearsedAt: "2026-10-04T00:00:00.000Z",
    rehearsalCount: 1,
  };
  const bank = [
    { ...stories[0], rehearsedAt: null, rehearsalCount: 0 },
    rehearsedConflict,
  ];
  const preferred = pickStory(
    "Tell me about a time you disagreed with a stakeholder",
    bank,
  );
  if (preferred?.name !== "Stakeholder conflict") {
    throw new Error(`rehearsed pick expected conflict, got ${preferred?.name ?? "none"}`);
  }
  const fallback = pickStory("How did you handle a latency incident in payments?", bank);
  if (fallback?.name !== "Payments p99") {
    throw new Error(`unrehearsed match should still pick, got ${fallback?.name ?? "none"}`);
  }

  const plan = buildPracticePlan({
    track: "software",
    title: "Backend engineer",
    company: "Northwind",
    stories,
  });
  if (plan[0]?.text !== "Tell me about yourself.") {
    throw new Error(`practice should start with intro, got ${plan[0]?.text}`);
  }
  if (!plan.some((item) => item.storyName === "Stakeholder conflict")) {
    throw new Error("practice should drill the conflict story");
  }
  if (!plan.some((item) => /URL shortener/i.test(item.text))) {
    throw new Error("software practice should include a design closer");
  }
  if (plan.at(-1)?.stage !== "wrap") {
    throw new Error("practice should end on close");
  }

  const ladder = parseLadder(
    "Hot shard, not CAP\n\nSAY\nI'd partition by merchant.\n\nPUSH\nWatch write-QPS per partition.\n\nTRAP\nDo not define partitioning.",
  );
  if (ladder.gist !== "Hot shard, not CAP") {
    throw new Error(`ladder gist: ${ladder.gist}`);
  }
  if (!ladder.say.includes("merchant") || !ladder.push.includes("write-QPS")) {
    throw new Error("ladder missing say/push");
  }
  if (!ladder.trap.toLowerCase().includes("partition")) {
    throw new Error(`ladder trap: ${ladder.trap}`);
  }
  const legacy = parseLadder("Cache first\n\nI'd put Redis in front of the ledger.");
  if (legacy.gist !== "Cache first" || !legacy.say.includes("Redis") || legacy.push) {
    throw new Error("legacy answers should stay in say");
  }

  if (!isFollowUpQuestion("Why that choice?")) {
    throw new Error("expected why-that to be a follow-up");
  }
  if (isFollowUpQuestion("Tell me about a time you failed")) {
    throw new Error("new STAR question is not a follow-up");
  }
  const locked = pickLockedStory(
    "Why that choice?",
    stories,
    { ...emptyClaims(), story: "Stakeholder conflict" },
  );
  if (locked?.name !== "Stakeholder conflict") {
    throw new Error(`follow-up should keep locked story, got ${locked?.name ?? "none"}`);
  }
  const claims = heuristicClaims({
    answer:
      "Billing delay\n\nSAY\nAt Northwind I pushed the PM and delayed a week. p99 was not the point.\n\nPUSH\nRedis was already in.\n",
    story: stories[1],
    prior: emptyClaims(),
  });
  if (claims.story !== "Stakeholder conflict") {
    throw new Error(`claims story ${claims.story}`);
  }
  if (!claims.employer.includes("Northwind")) {
    throw new Error(`claims employer ${claims.employer}`);
  }
  if (!claims.numbers.some((n) => /week/i.test(n))) {
    throw new Error(`claims numbers ${claims.numbers.join(",")}`);
  }
}

function checkIntent() {
  const cases: [string, string][] = [
    ["Design a URL shortener", "system_design"],
    ["Tell me about yourself", "intro"],
    ["Any questions for us?", "wrap"],
    ["Tell me about a time you failed", "behavioral"],
    ["Write a function that reverses a linked list", "coding"],
  ];
  for (const [text, stage] of cases) {
    const got = inferStage(text);
    if (got !== stage) throw new Error(`inferStage(${text}) => ${got}, expected ${stage}`);
  }
  if (classifyIntent("Is everything all right?", { hasTurns: true }) !== "check_in") {
    throw new Error("check-in should be ignored");
  }
  if (classifyIntent("Why that?", { hasTurns: true }) !== "probe") {
    throw new Error("why-that should be a probe");
  }
  if (!isShallowProbe("Why that?")) {
    throw new Error("why-that is a shallow probe and should keep the card");
  }
  if (classifyIntent("Tell me about a time you failed", { hasTurns: true }) !== "question") {
    throw new Error("new STAR question is not a probe");
  }
  if (classifyIntent("How is data partitioned across shards?", { hasTurns: true }) !== "question") {
    throw new Error("deep follow-up should still answer");
  }
  if (isShallowProbe("How would you improve it?")) {
    throw new Error("improve-it is not shallow");
  }
  if (classifyIntent("How would you improve it?", { hasTurns: true }) !== "probe") {
    throw new Error("improve-it should stay on the last story");
  }
  if (classifyIntent("Think about the write path", { hasTurns: true }) !== "hint") {
    throw new Error("hint should hold the card");
  }
  if (classifyIntent("Any questions for us?", { hasTurns: true }) !== "wrap") {
    throw new Error("close should be wrap");
  }
}

function loadEnv() {
  for (const file of [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
  ]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq);
      let value = trimmed.slice(eq + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

class VirtualClock {
  now = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void; cancelled: boolean }[] =
    [];

  schedule = (fn: () => void, ms: number) => {
    const timer = { id: ++this.seq, at: this.now + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  advance(ms: number) {
    this.now += ms;
    this.flush();
  }

  private flush() {
    let ran = true;
    while (ran) {
      ran = false;
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= this.now)
        .sort((a, b) => a.at - b.at);
      this.timers = this.timers.filter((timer) => !due.includes(timer));
      for (const timer of due) {
        timer.fn();
        ran = true;
      }
    }
  }
}

type CaseResult = {
  id: string;
  track: string;
  expectQuestion: boolean;
  detected: boolean;
  recalled: boolean;
  falseAlarm: boolean;
  premature: boolean;
  specialist: string;
  specialistOk: boolean | null;
  finalText: string;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
};

function pausesFor(item: ReplayCase) {
  if (item.pausesMs?.length) return item.pausesMs;
  return item.segments.map((_, i) =>
    i === item.segments.length - 1 ? 1200 : 400,
  );
}

function replayCase(item: ReplayCase): Omit<
  CaseResult,
  "ttftMs" | "inputTokens" | "outputTokens" | "model"
> {
  const clock = new VirtualClock();
  const finals: { text: string; at: number; force?: boolean }[] = [];
  const assembler = new TurnAssembler({
    scheduler: { schedule: clock.schedule },
    onPending: () => undefined,
    onFinalTurn: (text, force) => {
      finals.push({ text, at: segmentIndex, force });
    },
  });

  let segmentIndex = -1;
  for (let i = 0; i < item.segments.length; i += 1) {
    if (i > 0) assembler.handleSpeechStart();
    segmentIndex = i;
    assembler.handleSegment(item.segments[i]);
    clock.advance(pausesFor(item)[i] ?? 400);
  }
  if (item.commit) assembler.commitNow();
  clock.advance(50);

  const final = finals[0];
  const detected = Boolean(final && (item.commit || isQuestionLike(final.text)));
  const recalled = item.expect.question && detected;
  const falseAlarm = !item.expect.question && Boolean(final);
  const completeOnLast = item.expect.completeOnLast ?? item.segments.length > 1;
  const premature =
    Boolean(final) &&
    completeOnLast &&
    item.segments.length > 1 &&
    !item.commit &&
    final.at < item.segments.length - 1;

  const asked = final ? extractLatestQuestion(final.text) : "";
  const specialist = asked ? routeQuestion(asked, item.track).id : "";
  const specialistOk =
    item.expect.question && item.expect.specialist
      ? specialist === item.expect.specialist
      : item.expect.question
        ? null
        : true;

  return {
    id: item.id,
    track: item.track,
    expectQuestion: item.expect.question,
    detected,
    recalled,
    falseAlarm,
    premature,
    specialist,
    specialistOk,
    finalText: final?.text ?? "",
  };
}

function pct(n: number, d: number) {
  if (!d) return "—";
  return `${((100 * n) / d).toFixed(0)}%`;
}

function avg(values: number[]) {
  if (!values.length) return "—";
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length).toString();
}

function printTable(rows: CaseResult[]) {
  const questions = rows.filter((row) => row.expectQuestion);
  const nonQuestions = rows.filter((row) => !row.expectQuestion);
  const recalled = questions.filter((row) => row.recalled).length;
  const falseAlarms = nonQuestions.filter((row) => row.falseAlarm).length;
  const premature = rows.filter((row) => row.premature).length;
  const answered = rows.filter((row) => row.detected).length;
  const specialistChecked = rows.filter((row) => row.specialistOk !== null);
  const specialistHits = specialistChecked.filter((row) => row.specialistOk).length;

  console.log("\nCase results\n");
  console.log(
    [
      "id".padEnd(32),
      "track".padEnd(12),
      "q".padEnd(4),
      "hit".padEnd(4),
      "early".padEnd(6),
      "agent".padEnd(16),
      "ok".padEnd(4),
      "ttft".padEnd(6),
      "in".padEnd(6),
      "out".padEnd(5),
    ].join(" "),
  );
  for (const row of rows) {
    console.log(
      [
        row.id.slice(0, 32).padEnd(32),
        row.track.padEnd(12),
        row.expectQuestion ? "Y" : "n",
        row.recalled ? "Y" : row.falseAlarm ? "FP" : row.expectQuestion ? "miss" : "—",
        row.premature ? "Y" : "—",
        (row.specialist || "—").padEnd(16),
        row.specialistOk === null ? "—" : row.specialistOk ? "Y" : "n",
        row.ttftMs != null ? String(row.ttftMs) : "—",
        row.inputTokens != null ? String(row.inputTokens) : "—",
        row.outputTokens != null ? String(row.outputTokens) : "—",
      ]
        .map((cell, i) =>
          i === 0
            ? cell
            : String(cell).padEnd([12, 4, 4, 6, 16, 4, 6, 6, 5][i - 1] ?? 6),
        )
        .join(" "),
    );
  }

  const byTrack = new Map<string, CaseResult[]>();
  for (const row of rows) {
    const list = byTrack.get(row.track) ?? [];
    list.push(row);
    byTrack.set(row.track, list);
  }

  console.log("\nBy track\n");
  console.log(
    [
      "track".padEnd(12),
      "recall".padEnd(8),
      "premature".padEnd(10),
      "agent".padEnd(8),
      "ttft".padEnd(8),
      "tok/in".padEnd(8),
      "tok/out".padEnd(8),
    ].join(" "),
  );
  for (const [track, list] of [...byTrack.entries()].sort()) {
    const q = list.filter((row) => row.expectQuestion);
    const rec = q.filter((row) => row.recalled).length;
    const early = list.filter((row) => row.premature).length;
    const agents = list.filter((row) => row.specialistOk !== null);
    const hits = agents.filter((row) => row.specialistOk).length;
    console.log(
      [
        track.padEnd(12),
        pct(rec, q.length).padEnd(8),
        pct(early, answered || list.length).padEnd(10),
        pct(hits, agents.length).padEnd(8),
        avg(list.map((row) => row.ttftMs).filter((n): n is number => n != null)).padEnd(8),
        avg(list.map((row) => row.inputTokens).filter((n): n is number => n != null)).padEnd(8),
        avg(list.map((row) => row.outputTokens).filter((n): n is number => n != null)).padEnd(8),
      ].join(" "),
    );
  }

  console.log("\nSummary\n");
  console.log(`  cases              ${rows.length}`);
  console.log(`  question recall    ${pct(recalled, questions.length)}  (${recalled}/${questions.length})`);
  console.log(
    `  false-alarm rate   ${pct(falseAlarms, nonQuestions.length)}  (${falseAlarms}/${nonQuestions.length})`,
  );
  console.log(`  premature answers  ${pct(premature, answered)}  (${premature}/${answered || 0} fired)`);
  console.log(
    `  specialist match   ${pct(specialistHits, specialistChecked.length)}  (${specialistHits}/${specialistChecked.length})`,
  );
  const ttfts = rows.map((row) => row.ttftMs).filter((n): n is number => n != null);
  const ins = rows.map((row) => row.inputTokens).filter((n): n is number => n != null);
  const outs = rows.map((row) => row.outputTokens).filter((n): n is number => n != null);
  if (ttfts.length) {
    console.log(`  avg TTFT           ${avg(ttfts)} ms`);
    console.log(`  avg tokens in/out  ${avg(ins)} / ${avg(outs)}`);
  } else {
    console.log("  TTFT / tokens      skipped (pass --live to generate answers)");
  }
}

async function main() {
  checkStoryPick();
  checkIntent();
  loadEnv();
  const live = process.argv.includes("--live");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;
  const trackArg = process.argv.find((arg) => arg.startsWith("--track="));
  const track = trackArg?.slice("--track=".length);

  const cases = FIXTURES.filter((item) => !track || item.track === track);
  const results: CaseResult[] = [];
  let liveLeft = limit;

  for (const item of cases) {
    const base = replayCase(item);
    const row: CaseResult = { ...base };
    if (live && base.detected && base.finalText && liveLeft > 0) {
      liveLeft -= 1;
      const specialist = routeQuestion(base.finalText, item.track);
      try {
        const answer = await collectAnswer({
          question: base.finalText,
          specialist,
          track: item.track,
          brief: "Interviewing for the role. No resume on file.",
          prior: [],
        });
        row.ttftMs = answer.ttftMs;
        row.inputTokens = answer.inputTokens;
        row.outputTokens = answer.outputTokens;
        row.model = answer.model;
      } catch (err) {
        console.error(`[live] ${item.id}:`, err instanceof Error ? err.message : err);
      }
    }
    results.push(row);
  }

  printTable(results);
  const failed =
    results.some((row) => row.expectQuestion && !row.recalled) ||
    results.some((row) => row.falseAlarm) ||
    results.some(
      (row) =>
        row.premature &&
        !FIXTURES.find((item) => item.id === row.id)?.expect.premature,
    ) ||
    results.some((row) => row.specialistOk === false);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
