import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkKnowledge, pickKnowledge } from "./modeKnowledge.js";

const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about onboarding, benefits, and office snacks.`).join("\n\n");
const doc = `### Handbook\n${filler}\n\nThe Zephyr billing service listens on port 7443 and pages the payments on-call.\n\n${filler}\n\n### Stack\nWe write backend services in Go 1.22 with Postgres 16.`;

test("chunks keep their section title", () => {
  const chunks = chunkKnowledge(doc);
  assert.ok(chunks.length > 4);
  assert.ok(chunks.every((chunk) => chunk.startsWith("### ")));
});

test("finds a fact buried deep in a long document", () => {
  const picked = pickKnowledge(chunkKnowledge(doc), "What port does the Zephyr service use?", 1500);
  assert.match(picked, /port 7443/);
  assert.ok(picked.length <= 1500 + 900);
});

test("matches a second section by its terms", () => {
  assert.match(pickKnowledge(chunkKnowledge(doc), "Which Postgres version do we run?", 1200), /Postgres 16/);
});

test("with no useful query terms it still returns leading context", () => {
  const picked = pickKnowledge(chunkKnowledge(doc), "help", 1000);
  assert.ok(picked.length > 0);
  assert.match(picked, /^### Handbook/);
});

test("empty knowledge gives nothing", () => {
  assert.equal(pickKnowledge([], "anything"), "");
});
