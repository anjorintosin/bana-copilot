/**
 * Compatibility facade. New code should import from llm/ or engine.ts.
 */
export { client, aiStatus, models } from "./llm/client.js";
export { analyzeScreen, type ScreenAnalysis, type ScreenKind } from "./llm/vision.js";
export {
  classifyTurn,
  streamAnswer,
  summarizeInterview,
  toSpoken,
  type InterviewKind,
} from "./engine.js";

import OpenAI, { toFile } from "openai";
import { NEED_KEY, client, models } from "./llm/client.js";
import type { InterviewKind } from "./engine.js";

const INTERVIEW_PROMPT =
  "Software engineering interview. Vocabulary: LeetCode, Big O, hash map, binary tree, linked list, two pointers, dynamic programming, REST, GraphQL, Postgres, Redis, Kafka, Kubernetes, latency, throughput, CAP theorem, ACID, sharding, load balancer, microservice, system design, STAR method.";

export async function transcribeChunk(
  dataBase64: string,
  mimeType: string,
  priorText = "",
): Promise<string> {
  const openai = client();
  if (!openai) {
    throw new Error(NEED_KEY);
  }
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length < 1500) return "";
  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  const file = await toFile(buf, `chunk.${ext}`, {
    type: mimeType || `audio/${ext}`,
  });
  const prompt = `${INTERVIEW_PROMPT} ${priorText.slice(-220)}`.trim();
  const preferred = models().stt === "gpt-4o-mini-transcribe" ? "whisper-1" : models().stt;

  try {
    const text = await withRetry(() =>
      runTranscription(openai, file, preferred, prompt),
    );
    return cleanTranscript(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/401|invalid api key|incorrect api key/i.test(message)) throw err;
    if (preferred === "whisper-1") throw err;
    const text = await runTranscription(openai, file, "whisper-1", prompt);
    return cleanTranscript(text);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/401|invalid api key|incorrect api key/i.test(message)) throw err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
      }
    }
  }
  throw last;
}

async function runTranscription(
  openai: OpenAI,
  file: Awaited<ReturnType<typeof toFile>>,
  model: string,
  prompt: string,
) {
  const result = await openai.audio.transcriptions.create(
    model === "whisper-1"
      ? { file, model, language: "en", prompt, temperature: 0 }
      : { file, model, language: "en", prompt },
    { timeout: 12_000 },
  );
  return result.text.trim();
}

function cleanTranscript(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < 3 || /^[.?,!\s]+$/.test(cleaned)) return "";
  return cleaned;
}

export type InterpretedSpeech = {
  cleanTranscript: string;
  isInterviewQuestion: boolean;
  kind: InterviewKind;
  question: string;
  confidence: number;
};
