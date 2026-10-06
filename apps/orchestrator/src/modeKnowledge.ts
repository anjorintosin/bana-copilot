import { chunkResume } from "./embeddings.js";

const STOP = new Set(
  "the and for are but not you your with this that from have has had was were will would can could should what when where which who why how does did doing into about over under than then them they their there here been being also just only very more most some such each other any all our out its it's i'm let use using used give tell show write explain find make".split(
    " ",
  ),
);

function terms(text: string) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#._-]{1,}/g) ?? [])
    .map((word) => word.replace(/[._-]+$/, ""))
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

export function chunkKnowledge(text: string) {
  const sections = text.split(/\n(?=### )/);
  return sections.flatMap((section) => {
    const title = section.match(/^### (.+)$/m)?.[1]?.trim() ?? "";
    return chunkResume(section, 900, 120).map((chunk) =>
      title && !chunk.startsWith("### ") ? `### ${title}\n${chunk}` : chunk,
    );
  });
}

/**
 * Picks the knowledge chunks most relevant to the question (lexical tf-idf), within a
 * character budget, in document order. With no usable query terms it returns the
 * leading chunks so screen turns still see the user's context.
 */
export function pickKnowledge(chunks: string[], query: string, budget = 4000) {
  if (!chunks.length) return "";
  const wanted = [...new Set(terms(query))];
  const docs = chunks.map((chunk) => terms(chunk));
  const df = new Map<string, number>();
  for (const words of docs) for (const word of new Set(words)) df.set(word, (df.get(word) ?? 0) + 1);

  const scored = chunks.map((chunk, index) => {
    const counts = new Map<string, number>();
    for (const word of docs[index]) counts.set(word, (counts.get(word) ?? 0) + 1);
    let score = 0;
    for (const word of wanted) {
      const tf = counts.get(word) ?? 0;
      if (tf) score += (1 + Math.log(tf)) * Math.log(1 + chunks.length / (df.get(word) ?? 1));
    }
    return { index, chunk, score };
  });

  const hits = scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  const ranked = hits.length ? hits : scored;
  const picked: typeof scored = [];
  let used = 0;
  for (const row of ranked) {
    if (used + row.chunk.length > budget && picked.length) continue;
    picked.push(row);
    used += row.chunk.length;
    if (used >= budget) break;
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((row) => row.chunk)
    .join("\n\n");
}
