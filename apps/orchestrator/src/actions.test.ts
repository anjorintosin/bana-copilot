import assert from "node:assert/strict";
import { test } from "node:test";
import { refersToScreen } from "./actions.js";

test("typed asks about the screen are solved from the screenshot", () => {
  for (const typed of [
    "solve the question on my screen",
    "Solve this",
    "answer this question",
    "what does this error mean",
    "what's on here",
  ]) {
    assert.ok(refersToScreen(typed), typed);
  }
});

test("ordinary typed questions are not screen requests", () => {
  for (const typed of ["what is a hash map", "tell me about yourself", "how do I solve conflicts at work"]) {
    assert.ok(!refersToScreen(typed), typed);
  }
});
