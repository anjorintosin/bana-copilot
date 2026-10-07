import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { answerSentences, checkGrounding, flagFromScores } from "./grounding.js";

afterEach(() => {
  delete process.env.JEV_FLAG_THRESHOLD;
});

test("no flag below the threshold", () => {
  assert.equal(flagFromScores({ invented: 0.65, contradicts: 0.3 }), null);
  assert.equal(flagFromScores(null), null);
});

test("flags invented facts at the default threshold", () => {
  assert.deepEqual(flagFromScores({ invented: 0.91, contradicts: 0.2 }), {
    kind: "invented",
    confidence: 0.91,
  });
});

test("prefers contradicts when it is the stronger signal", () => {
  assert.deepEqual(flagFromScores({ invented: 0.85, contradicts: 0.95 }), {
    kind: "contradicts",
    confidence: 0.95,
  });
});

test("threshold is configurable", () => {
  process.env.JEV_FLAG_THRESHOLD = "0.6";
  assert.equal(flagFromScores({ invented: 0.62, contradicts: 0 })?.kind, "invented");
  process.env.JEV_FLAG_THRESHOLD = "7";
  assert.equal(flagFromScores({ invented: 0.62, contradicts: 0 }), null);
});

test("sentences match what the HUD shows: no markdown, list markers, or code", () => {
  const answer = [
    "**I led the payments migration at Stripe.** It cut failed charges by 30% in two quarters.",
    "",
    "1. First, I mapped every `charge` path.",
    "```python",
    "def charge(): pass",
    "```",
    "Ok.",
  ].join("\n");
  assert.deepEqual(answerSentences(answer), [
    "I led the payments migration at Stripe.",
    "It cut failed charges by 30% in two quarters.",
    "First, I mapped every charge path.",
  ]);
});

test("skips the network call without a key", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.equal(await checkGrounding({ question: "q", answer: "a", evidence: "e" }), null);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
