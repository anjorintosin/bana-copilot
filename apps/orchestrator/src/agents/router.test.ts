import assert from "node:assert/strict";
import { test } from "node:test";
import { isFollowUp } from "./router.js";

test("language switches and short probes are follow-ups", () => {
  for (const text of ["in js", "in JavaScript", "write it in python", "now in Go", "can you do it in c++", "java", "more", "more again", "tell me more", "why"]) {
    assert.equal(isFollowUp(text), true, text);
  }
});

test("new questions are not follow-ups", () => {
  for (const text of ["what is typescript", "Design a rate limiter", "in what situations would you use a queue over a stream?", "javascript closures explained with an example please"]) {
    assert.equal(isFollowUp(text), false, text);
  }
});
