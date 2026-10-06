import assert from "node:assert/strict";
import { test } from "node:test";
import { answerPlainText, formatAnswer, texToText, timesSigns } from "./answer";

test("multiplication stars become ×, markdown and code stay intact", () => {
  assert.equal(timesSigns("2*26*26 + 3*26 + 1"), "2×26×26 + 3×26 + 1");
  assert.equal(timesSigns("O(L * S * 26)"), "O(L × S × 26)");
  assert.equal(timesSigns("dp[i]*2"), "dp[i]×2");
  assert.equal(timesSigns("use **bold** here"), "use **bold** here");
  assert.equal(timesSigns("an *aside* note"), "an *aside* note");
  assert.equal(timesSigns("run `a*b` then 2*3"), "run `a*b` then 2×3");
  assert.match(formatAnswer("Total is 26 * 26 = 676 for **prefix a**."), /26 × 26 = 676 for <strong>prefix a<\/strong>/);
});

test("inline TeX becomes readable text", () => {
  assert.equal(texToText("O(n\\log^2 n)"), "O(n log² n)");
  assert.equal(texToText("O(\\log n)"), "O(log n)");
  assert.equal(texToText("d[u] + d[v] \\le K"), "d[u] + d[v] ≤ K");
  assert.equal(texToText("n^{2}"), "n²");
  assert.equal(texToText("(1,5)"), "(1,5)");
});

test("$$math$$ renders as a math span, not a code chip", () => {
  const html = formatAnswer("Count pairs with sum at most $$K$$ in $$O(n \\log^2 n)$$ time.");
  assert.match(html, /<span class="math">K<\/span>/);
  assert.match(html, /<span class="math">O\(n log² n\)<\/span>/);
  assert.doesNotMatch(html, /<code>K<\/code>/);
  assert.doesNotMatch(html, /\$/);
});

test("prices are not treated as math", () => {
  const html = formatAnswer("It costs $10 and $20 per seat.");
  assert.match(html, /\$10 and \$20/);
  assert.doesNotMatch(html, /class="math"/);
});

test("Cluely-shaped coding answer renders bold lead, ordered steps, and notes", () => {
  const html = formatAnswer(
    [
      "Use **centroid decomposition** in $$O(n\\log^2 n)$$ time.",
      "",
      "1. Collect distances from the centroid, including 0.",
      "2. Sort and count pairs with two pointers.",
      "3. Subtract same-subtree pairs.",
      "",
      "Each valid pair is counted exactly once.",
    ].join("\n"),
    true,
  );
  assert.match(html, /<p>Use <strong>centroid decomposition<\/strong> in <span class="math">/);
  assert.match(html, /<ol class="ans-list"><li><span class="ans-num">1\.<\/span> Collect distances/);
  assert.match(html, /<span class="ans-num">3\.<\/span> Subtract/);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /<p>Each valid pair is counted exactly once\.<\/p>$/);
});

test("code fences always render as a code block", () => {
  const html = formatAnswer("Steps.\n\n```python\nprint(1)\n```");
  assert.match(html, /class="code-block"/);
  assert.match(html, /<span>python<\/span>/);
});

test("copied answer keeps line breaks and list numbers", () => {
  const text = answerPlainText(
    [
      "Use **centroid decomposition** in $$O(n\\log^2 n)$$ total time.",
      "1. Pick a centroid.",
      "2. Collect distances, including 0 for the centroid.",
      "",
      "Each pair is counted once.",
      "",
      "```python",
      "x = a ** 2",
      "```",
    ].join("\n"),
  );
  assert.equal(
    text,
    [
      "Use centroid decomposition in O(n log² n) total time.",
      "",
      "1. Pick a centroid.",
      "2. Collect distances, including 0 for the centroid.",
      "",
      "Each pair is counted once.",
      "",
      "```python",
      "x = a ** 2",
      "```",
    ].join("\n"),
  );
});
