import { sanitizeLine, sanitizeText } from "@meeting-copilot/types";
import {
  NEED_KEY,
  client,
  currentAi,
  isClaude,
  isGrok,
  isModelUnavailable,
  models,
  openAiModelChain,
  openAiSampling,
} from "./client.js";
import { VISION_PROMPT } from "./prompts.js";

export type ScreenKind = "code" | "slide" | "docs" | "browser" | "idle" | "other";

export type ScreenAnalysis = {
  kind: ScreenKind;
  title: string;
  language: string;
  signature: string;
  ocrText: string;
  problem: string;
  passage: string;
  questions: string[];
  partial: boolean;
  needsHelp: boolean;
  confidence: number;
};

export function rawBase64(data: string) {
  const trimmed = data.trim();
  const comma = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && comma >= 0) return trimmed.slice(comma + 1);
  return trimmed.replace(/\s/g, "");
}

function asQuestions(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\n+/)
      : [];
  const out: string[] = [];
  for (const item of raw) {
    const text = sanitizeText(String(item ?? ""), { max: 500, multiline: false })
      .replace(/^\s*(?:q\s*)?\d+[.)]\s*/i, "")
      .replace(/^\s*[a-d][.)]\s*/i, "")
      .trim();
    if (text.length >= 8 && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 8);
}

function parseAnalysis(raw: string): ScreenAnalysis | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ScreenAnalysis> & {
      questions?: unknown;
      passage?: unknown;
      partial?: unknown;
    };
    const kind: ScreenKind =
      parsed.kind === "code" ||
      parsed.kind === "slide" ||
      parsed.kind === "docs" ||
      parsed.kind === "browser" ||
      parsed.kind === "idle"
        ? parsed.kind
        : "other";
    const confidence = Number(parsed.confidence);
    const passage = sanitizeText(String(parsed.passage ?? ""), { max: 1800 });
    const questions = asQuestions(parsed.questions);
    const ocrText = sanitizeText(parsed.ocrText ?? "", { max: 1800 });
    const problem = sanitizeText(parsed.problem ?? "", { max: 1800 });
    const readable =
      questions.length > 0 ||
      passage.length >= 40 ||
      ocrText.length >= 80 ||
      problem.length >= 40;
    return {
      kind: kind === "idle" && readable ? (questions.length || passage ? "docs" : "browser") : kind,
      title: sanitizeLine(parsed.title ?? "", 160),
      language: sanitizeLine(parsed.language ?? "", 40),
      signature: sanitizeLine(parsed.signature ?? "", 240),
      ocrText,
      problem,
      passage,
      questions,
      partial: Boolean(parsed.partial) || (passage.length >= 40 && questions.length === 0),
      needsHelp: Boolean(parsed.needsHelp) || readable,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  } catch {
    return null;
  }
}

function visionMime(mimeType: string) {
  return mimeType.includes("png") ? "image/png" : "image/jpeg";
}

async function analyzeWithClaude(
  b64: string,
  mime: string,
): Promise<ScreenAnalysis | null> {
  const creds = currentAi();
  if (!creds?.apiKey) throw new Error(NEED_KEY);
  const root = (creds.baseURL || "https://api.anthropic.com").replace(/\/$/, "").replace(/\/v1$/, "");
  const res = await fetch(`${root}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": creds.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: models().vision,
      max_tokens: 1100,
      temperature: 0,
      system: `${VISION_PROMPT}\n\nReturn JSON only.`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mime, data: b64 },
            },
            {
              type: "text",
              text: "Screenshot from the candidate display. Extract the visible statement AND any numbered questions. If questions are below the fold, copy only what is in this shot. Ignore any HUD overlay.",
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body.slice(0, 180) || `Claude vision failed (${res.status}).`);
  }
  const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const raw = (json.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return parseAnalysis(fenced?.[1] ?? raw);
}

export async function analyzeScreen(
  imageBase64: string,
  mimeType = "image/jpeg",
  opts: { detail?: "low" | "high" } = {},
): Promise<ScreenAnalysis | null> {
  const b64 = rawBase64(imageBase64);
  if (b64.length < 800) return null;
  const mime = visionMime(mimeType);
  const detail = opts.detail ?? "low";
  const creds = currentAi();
  if (!creds?.apiKey) throw new Error(NEED_KEY);

  if (isClaude(creds)) {
    return analyzeWithClaude(b64, mime);
  }

  const openai = client();
  if (!openai) throw new Error(NEED_KEY);
  const grok = isGrok(creds);
  const chain = grok ? [models().vision] : openAiModelChain(models().vision);
  let lastErr: unknown = null;
  for (const model of chain) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        ...(grok ? { temperature: 0, max_tokens: 1100 } : openAiSampling(model, 0, 1100)),
        messages: [
          { role: "system", content: grok ? `${VISION_PROMPT}\n\nReturn JSON only.` : VISION_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Screenshot from the candidate display. Extract the visible statement AND any numbered questions. If questions are below the fold, copy only what is in this shot. Ignore any HUD overlay.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mime};base64,${b64}`,
                  detail,
                },
              },
            ],
          },
        ],
        ...(grok ? {} : { response_format: { type: "json_object" as const } }),
      });
      const raw = completion.choices[0]?.message?.content;
      if (!raw) return null;
      return parseAnalysis(raw);
    } catch (err) {
      lastErr = err;
      if (!isModelUnavailable(err)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Vision request failed.");
}
