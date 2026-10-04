import { client, models } from "./llm/client.js";

export function chunkResume(text: string, size = 700, overlap = 90) {
  const normalized = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const paras = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const para of paras) {
    const next = buf ? `${buf}\n\n${para}` : para;
    if (next.length > size && buf) {
      chunks.push(buf);
      buf = `${buf.slice(-overlap)}\n\n${para}`.trim();
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);

  return chunks.flatMap((chunk) => {
    if (chunk.length <= size * 1.5) return [chunk];
    const parts: string[] = [];
    for (let i = 0; i < chunk.length; i += size - overlap) {
      parts.push(chunk.slice(i, i + size));
    }
    return parts;
  });
}

export async function embedTexts(texts: string[]) {
  const openai = client();
  if (!openai || !models().embed) {
    return texts.map(() => [] as number[]);
  }
  const result = await openai.embeddings.create({
    model: models().embed,
    input: texts,
  });
  return result.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => row.embedding);
}

export function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function rankChunks(
  query: number[],
  chunks: { text: string; embedding: number[] }[],
  k = 5,
) {
  return chunks
    .map((chunk) => ({ text: chunk.text, score: cosine(query, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((row) => row.score > 0.15);
}
