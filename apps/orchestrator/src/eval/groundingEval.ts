/**
 * Grounding eval: fixed answers with planted invented or contradicting facts, scored by
 * Jev and (with --baseline) the smart model, to pick JEV_FLAG_THRESHOLD before trusting it.
 *
 *   npm run eval:grounding -w @meeting-copilot/orchestrator [-- --baseline]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { scoreGrounding, type GroundingScores } from "../grounding.js";
import { completeChat } from "../llm/chat.js";
import { models } from "../llm/client.js";
import { jevEnabled } from "../llm/jev.js";

const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "../../../../.env") });

const EVIDENCE = `Candidate profile and mode:
Name: Jane Okafor. Backend engineer at Stripe, June 2021 to August 2024, on the payments ledger team. Before that, software engineer at Shopify, 2018 to 2021, on checkout.
Skills: Python, Go, PostgreSQL, Kafka, Terraform.
Highlights: cut ledger write latency by 40% by batching inserts; led the migration of the ledger to partitioned Postgres tables over two quarters; mentored three junior engineers.
Mode "Acme onsite": Acme is a logistics company. Its event bus is Kafka and its main database is PostgreSQL. Acme values "own the outcome" and "customer obsession". Keep answers under a minute.

Retrieved for this question:
Story "Ledger migration": Situation: the ledger table hit 2 billion rows and writes slowed. Task: Jane owned the migration plan. Action: she proposed monthly partitions, dual-wrote for three weeks, and backfilled in batches. Result: p99 write latency dropped from 180ms to 110ms with zero downtime.

Already said in this interview:
Team size: Jane said her team had six engineers. Story told: Ledger migration.`;

type Case = { id: string; question: string; answer: string; planted: boolean };

const CASES: Case[] = [
  {
    id: "clean-story",
    planted: false,
    question: "Tell me about a time you led a difficult migration.",
    answer:
      "**At Stripe I led the ledger migration to partitioned Postgres with zero downtime.** The ledger table had hit 2 billion rows and writes were slowing, so I owned the plan. I proposed monthly partitions, dual-wrote for three weeks, and backfilled in batches. p99 write latency dropped from 180ms to 110ms.",
  },
  {
    id: "invented-employer",
    planted: true,
    question: "Walk me through your background.",
    answer:
      "**I'm a backend engineer focused on payments.** I started at Google on the Ads billing team, then moved to Stripe in 2021 where I worked on the payments ledger until 2024.",
  },
  {
    id: "invented-metric",
    planted: true,
    question: "What was the impact of the ledger migration?",
    answer:
      "**The migration cut our infrastructure costs by 70% and dropped p99 write latency from 180ms to 110ms.** We did it with zero downtime by dual-writing for three weeks.",
  },
  {
    id: "contradict-team-size",
    planted: true,
    question: "How big was your team?",
    answer: "**I was on a team of fifteen engineers on the ledger.** I mentored three of the junior engineers.",
  },
  {
    id: "contradict-mode-fact",
    planted: true,
    question: "How would you fit into Acme's stack?",
    answer:
      "**Acme runs on RabbitMQ and MongoDB, which I've used a lot.** I'd get productive quickly on the event pipeline.",
  },
  {
    id: "near-miss-date",
    planted: true,
    question: "When did you join Stripe?",
    answer: "**I joined Stripe in June 2020 and stayed until August 2024**, all on the payments ledger team.",
  },
  {
    id: "near-miss-latency",
    planted: true,
    question: "What did batching inserts do?",
    answer: "**Batching inserts cut ledger write latency by 60%.** It reduced round trips to Postgres per payment.",
  },
  {
    id: "clean-technical",
    planted: false,
    question: "What is database partitioning?",
    answer:
      "**Partitioning splits one large table into smaller physical pieces by a key, like month, while queries still see one table.** It keeps indexes small, lets old partitions be dropped cheaply, and lets the planner skip partitions that cannot match.",
  },
  {
    id: "clean-hypothetical",
    planted: false,
    question: "How would you design a rate limiter at Acme?",
    answer:
      "**I'd use a token bucket per client stored in Redis, with Kafka for audit events since Acme already runs it.** Each request takes a token; buckets refill at a fixed rate.",
  },
  {
    id: "clean-motivation",
    planted: false,
    question: "Why Acme?",
    answer:
      "**Acme's \"own the outcome\" value matches how I worked on the Stripe ledger.** I owned the partition migration end to end, and logistics has the same kind of high-volume event data I enjoy working with.",
  },
  {
    id: "clean-paraphrase",
    planted: false,
    question: "What are you proudest of at Stripe?",
    answer:
      "**Batching ledger inserts, which cut write latency by about 40 percent.** I also mentored three junior engineers on the team while we moved the ledger to partitioned tables.",
  },
  {
    id: "clean-general-numbers",
    planted: false,
    question: "How fast is Redis?",
    answer:
      "**A single Redis node typically handles on the order of 100k simple operations per second.** Latency is usually sub-millisecond on the same network; throughput drops with large values or Lua-heavy workloads.",
  },
  {
    id: "clean-skill-use",
    planted: false,
    question: "How would you provision the infrastructure?",
    answer:
      "**I'd define it in Terraform, which I've used before, with one module per service.** State goes in a remote backend with locking, and changes go through plan review in CI.",
  },
  {
    id: "invented-tool",
    planted: true,
    question: "How did you deploy services at Stripe?",
    answer:
      "**I ran our ledger services on Kubernetes and wrote custom operators for failover.** That let us roll out schema changes service by service.",
  },
  {
    id: "invented-title",
    planted: true,
    question: "What was your role on the ledger team?",
    answer: "**I managed the ledger team of six engineers** and set the roadmap for the partition migration.",
  },
  {
    id: "inflated-scale",
    planted: true,
    question: "How big was the ledger?",
    answer: "**The ledger table had grown to about 20 billion rows**, which is why writes slowed and we partitioned by month.",
  },
  {
    id: "clean-general-advice",
    planted: false,
    question: "How do you handle disagreements with a manager?",
    answer:
      "**I disagree in private, with data, and then commit once a decision is made.** I write down the trade-offs, propose a small experiment if we're stuck, and escalate only when the risk is high.",
  },
];

async function baseline(item: Case): Promise<GroundingScores | null> {
  const raw = await completeChat({
    system:
      'You check an interview copilot answer against evidence. Return JSON {"invented": number, "contradicts": number}, each the probability 0-1. invented: the answer states a personal fact about the candidate (employer, title, project, metric, number, date, tool they used) that the evidence does not state; general knowledge and advice do not count. contradicts: the answer contradicts the evidence or earlier claims.',
    user: `Evidence:\n${EVIDENCE}\n\nQuestion: ${item.question}\n\nAnswer:\n${item.answer}`,
    model: models().smart,
    temperature: 0,
    maxTokens: 120,
    json: true,
  });
  try {
    const parsed = JSON.parse(raw) as GroundingScores;
    return { invented: Number(parsed.invented), contradicts: Number(parsed.contradicts) };
  } catch {
    return null;
  }
}

function worst(scores: GroundingScores | null) {
  return scores ? Math.max(scores.invented, scores.contradicts) : NaN;
}

function sweep(label: string, rows: { item: Case; score: number }[]) {
  const planted = rows.filter((row) => row.item.planted);
  const clean = rows.filter((row) => !row.item.planted);
  console.log(`\n${label}: threshold  caught  false alarms`);
  for (const cut of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const caught = planted.filter((row) => row.score >= cut).length;
    const false_ = clean.filter((row) => row.score >= cut).length;
    console.log(`  ${cut.toFixed(1)}        ${caught}/${planted.length}     ${false_}/${clean.length}`);
  }
}

async function main() {
  if (!jevEnabled()) {
    console.log("TYPESAFE_API_KEY is not set (or JEV_GROUNDING=off); skipping the Jev grounding eval.");
    return;
  }
  const withBaseline = process.argv.includes("--baseline");
  const jevRows: { item: Case; score: number; ms: number }[] = [];
  const llmRows: { item: Case; score: number; ms: number }[] = [];

  for (const item of CASES) {
    let started = Date.now();
    const jev = await scoreGrounding({ question: item.question, answer: item.answer, evidence: EVIDENCE });
    jevRows.push({ item, score: worst(jev), ms: Date.now() - started });
    let line = `${item.planted ? "planted" : "clean  "}  ${item.id.padEnd(22)} jev ${jev ? `inv ${jev.invented.toFixed(2)} con ${jev.contradicts.toFixed(2)}` : "error"} (${Date.now() - started}ms)`;
    if (withBaseline) {
      started = Date.now();
      const llm = await baseline(item).catch(() => null);
      llmRows.push({ item, score: worst(llm), ms: Date.now() - started });
      line += `  llm ${llm ? `inv ${llm.invented.toFixed(2)} con ${llm.contradicts.toFixed(2)}` : "error"} (${Date.now() - started}ms)`;
    }
    console.log(line);
  }

  const avg = (rows: { ms: number }[]) => Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / rows.length);
  sweep(`Jev (avg ${avg(jevRows)}ms)`, jevRows);
  if (withBaseline) sweep(`Smart model (avg ${avg(llmRows)}ms)`, llmRows);
}

void main();
