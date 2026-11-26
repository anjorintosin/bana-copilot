import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversation, pickAssistTarget, type ConversationState } from "./assist.js";

const base = {
  action: "assist" as const,
  typed: "",
  sentImage: false,
  anyImage: false,
  freshSpeech: "",
  hasTurns: false,
};

test("a question asked out loud beats the screen", () => {
  const target = pickAssistTarget({
    ...base,
    sentImage: true,
    anyImage: true,
    freshSpeech: "Tell me about a time you disagreed with your manager.",
  });
  assert.equal(target.mode, "conversation");
});

test("a statement-shaped request still counts as the ask", () => {
  const target = pickAssistTarget({ ...base, freshSpeech: "Let's talk about your experience with Kafka." });
  assert.equal(target.mode, "conversation");
});

test("the screen is solved only when nothing new was said", () => {
  assert.equal(pickAssistTarget({ ...base, anyImage: true, freshSpeech: "" }).mode, "screen");
  assert.equal(pickAssistTarget({ ...base, anyImage: true, freshSpeech: "okay" }).mode, "screen");
});

test("typed text wins, and goes to the screen only when it points there", () => {
  assert.equal(pickAssistTarget({ ...base, typed: "what is a b-tree", anyImage: true, sentImage: true }).mode, "typed");
  assert.equal(pickAssistTarget({ ...base, typed: "solve the question on my screen", sentImage: true, anyImage: true }).mode, "screen");
  assert.equal(pickAssistTarget({ ...base, typed: "solve this", sentImage: false, anyImage: true }).mode, "typed");
});

test("pressing Assist again with nothing new goes deeper instead of repeating", () => {
  assert.equal(pickAssistTarget({ ...base, hasTurns: true }).mode, "continue");
});

test("buttons and empty asks", () => {
  assert.deepEqual(pickAssistTarget({ ...base, action: "recap" }), { mode: "button", action: "recap" });
  assert.equal(pickAssistTarget({ ...base, action: "ask" }).mode, "none");
  assert.equal(pickAssistTarget({ ...base, action: "screen" }).mode, "none");
  assert.equal(pickAssistTarget(base).mode, "none");
});

function session(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    startedAt: 0,
    transcript: [],
    partial: "",
    answeredAt: 0,
    turns: [],
    rollingSummary: "",
    ...overrides,
  };
}

test("the whole conversation is kept, with earlier answers in place and only new speech fresh", () => {
  const convo = buildConversation(
    session({
      transcript: [
        { at: 1_000, text: "How would you design a URL shortener?", source: "system" },
        { at: 60_000, text: "Why did you pick that database?", source: "system" },
      ],
      turns: [{ question: "How would you design a URL shortener?", kind: "system_design", answer: "Use a key-value store.", at: 2_000 }],
      answeredAt: 30_000,
    }),
  );
  const lines = convo.log.split("\n");
  assert.match(lines[0], /^\[0:01\] Them: How would you design a URL shortener\?/);
  assert.match(lines[1], /You were shown .*Use a key-value store/);
  assert.match(lines[2], /new since your last answer/);
  assert.match(lines[3], /^\[1:00\] Them: Why did you pick that database\?/);
  assert.equal(convo.fresh, "Why did you pick that database?");
});

test("before any answer everything is fresh and back-to-back speech is joined", () => {
  const convo = buildConversation(
    session({
      transcript: [
        { at: 1_000, text: "So, next one.", source: "system" },
        { at: 2_500, text: "Walk me through how a hash map resizes.", source: "system" },
      ],
    }),
  );
  assert.equal(convo.log, "[0:01] Them: So, next one. Walk me through how a hash map resizes.");
  assert.equal(convo.fresh, "So, next one. Walk me through how a hash map resizes.");
});

test("words still being transcribed are included as the newest speech", () => {
  const convo = buildConversation(session({ partial: "and what about the failure case" }));
  assert.match(convo.log, /still being transcribed\): and what about the failure case/);
  assert.equal(convo.fresh, "and what about the failure case");
});

test("very long conversations keep the newest part and the summary", () => {
  const transcript = Array.from({ length: 3_000 }, (_, i) => ({
    at: i * 10_000,
    text: `Segment ${i} with some words to make the line long enough.`,
    source: "system" as const,
  }));
  const convo = buildConversation(session({ transcript, rollingSummary: "They covered caching." }));
  assert.ok(convo.log.length <= 60_200);
  assert.match(convo.log, /^Earlier in this conversation \(summary\):\nThey covered caching\./);
  assert.match(convo.log, /Segment 2999 /);
});

test("without server-side speech the HUD transcript is used", () => {
  const convo = buildConversation(session(), "Can you explain closures?");
  assert.equal(convo.fresh, "Can you explain closures?");
  assert.match(convo.log, /Them \(recent\): Can you explain closures\?/);
});
