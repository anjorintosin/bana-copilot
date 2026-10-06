import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  clearAssistBuffer,
  isQuestionLike,
  markAssistAnswered,
  pushTranscript,
  sliceAssistWindow,
} from "./assistBuffer";

beforeEach(() => clearAssistBuffer());

test("spoken requests without a question mark count as questions", () => {
  for (const said of [
    "Design a URL shortener for me.",
    "Okay, so describe a time you disagreed with your manager.",
    "Implement a function that reverses a linked list.",
    "Great. Now walk me through your resume.",
    "Thanks for that. Explain how indexes work in Postgres.",
    "Thanks, tell me about a time you disagreed with your manager.",
    "Perfect, got it. Walk me through how you'd debug a memory leak.",
  ]) {
    assert.ok(isQuestionLike(said), said);
  }
});

test("plain statements are not questions", () => {
  for (const said of ["Thanks, that makes sense.", "I worked on payments at Stripe.", "Okay."]) {
    assert.ok(!isQuestionLike(said), said);
  }
});

test("Assist picks the newest question and keeps the conversation before it", () => {
  const start = 1_000_000;
  pushTranscript("Tell me about your last project.", start);
  pushTranscript("I built a payments ledger.", start + 6_000);
  pushTranscript("Design a rate limiter for that API.", start + 12_000);
  pushTranscript("Keep it simple.", start + 13_000);
  const pack = sliceAssistWindow(start + 15_000);
  assert.equal(pack.question, "Design a rate limiter for that API. Keep it simple.");
  assert.match(pack.transcript, /payments ledger.*rate limiter/);
});

test("a later question replaces the one already answered", () => {
  const start = 2_000_000;
  pushTranscript("Design a URL shortener for me.", start);
  pushTranscript("Thanks, tell me about a time you disagreed with your manager.", start + 15_000);
  assert.equal(
    sliceAssistWindow(start + 17_000).question,
    "Thanks, tell me about a time you disagreed with your manager.",
  );
});

test("short follow-ups count as questions", () => {
  for (const said of [
    "Why?",
    "How so?",
    "Okay, expand on that.",
    "Elaborate on the caching part.",
    "Go deeper on the token bucket.",
    "Interesting. Say more about the rollback.",
    "Give me an example.",
    "And then?",
  ]) {
    assert.ok(isQuestionLike(said), said);
  }
});

test("a follow-up after an answered question is the new ask, not the old question again", () => {
  const start = 4_000_000;
  pushTranscript("Design a rate limiter for our public API.", start);
  markAssistAnswered(start + 3_000);
  pushTranscript("Okay, go deeper on the token bucket.", start + 20_000);
  const pack = sliceAssistWindow(start + 22_000);
  assert.equal(pack.question, "Okay, go deeper on the token bucket.");
  assert.match(pack.transcript, /rate limiter.*token bucket/);
});

test("anything said after an answer is the ask, even without question words", () => {
  const start = 5_000_000;
  pushTranscript("Tell me about a time you handled an outage.", start);
  markAssistAnswered(start + 2_000);
  pushTranscript("Interesting, I'm curious about the part where the database failed over.", start + 25_000);
  assert.equal(
    sliceAssistWindow(start + 27_000).question,
    "Interesting, I'm curious about the part where the database failed over.",
  );
});

test("pressing Assist again with nothing new said re-answers the last question", () => {
  const start = 6_000_000;
  pushTranscript("What is a hash map?", start);
  markAssistAnswered(start + 2_000);
  assert.equal(sliceAssistWindow(start + 5_000).question, "What is a hash map?");
});

test("words that finish the question just after Assist stay with that question", () => {
  const start = 7_000_000;
  pushTranscript("Explain how indexes work", start);
  markAssistAnswered(start + 1_000);
  pushTranscript("in Postgres.", start + 1_500);
  assert.equal(sliceAssistWindow(start + 9_000).question, "Explain how indexes work in Postgres.");
});

test("when they kept talking after the last question, the newest thing said is the ask", () => {
  const start = 3_000_000;
  pushTranscript("What is a hash map?", start);
  pushTranscript(
    "Okay so the thing we care about on this team is that our ingestion pipeline drops events under load and we never figured out the backpressure story for it.",
    start + 8_000,
  );
  assert.match(sliceAssistWindow(start + 10_000).question, /^Okay so the thing we care about/);
});
