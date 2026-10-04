import { sanitizeLine, sanitizeText } from "@meeting-copilot/types";
import { NEED_KEY, client, currentAi, isClaude, models } from "./client.js";
import { VISION_PROMPT } from "./prompts.js";

export type ScreenKind = "code" | "slide" | "docs" | "browser" | "idle" | "other";

export type ScreenAnalysis = {
  kind: ScreenKind;
  title: string;
  language: string;
  signature: string;
  ocrText: string;
  problem: string;
  needsHelp: boolean;
  confidence: number;
};

export function rawBase64(data: string) {
  const trimmed = data.trim();
  const comma = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && comma >= 0) return trimmed.slice(comma + 1);
  return trimmed.replace(/\s/g, "");
}

function parseAnalysis(raw: string): ScreenAnalysis | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ScreenAnalysis>;
    const kind: ScreenKind =
      parsed.kind === "code" ||
      parsed.kind === "slide" ||
      parsed.kind === "docs" ||
      parsed.kind === "browser" ||
      parsed.kind === "idle"
        ? parsed.kind
        : "other";
    const confidence = Number(parsed.confidence);
    return {
      kind,
      title: sanitizeLine(parsed.title ?? "", 160),
      language: sanitizeLine(parsed.language ?? "", 40),
      signature: sanitizeLine(parsed.signature ?? "", 240),
      ocrText: sanitizeText(parsed.ocrText ?? "", { max: 1800 }),
      problem: sanitizeText(parsed.problem ?? "", { max: 1800 }),
      needsHelp: Boolean(parsed.needsHelp),
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
  const root = (creds.baseURL || "https://api.anthropic.com").replace(/\/$/, "");
  const res = await fetch(`${root}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": creds.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: models().vision,
      max_tokens: 900,
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
              text: "Screenshot from the candidate display. Extract the visible interview problem only. Ignore any HUD overlay.",
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
  const completion = await openai.chat.completions.create({
    model: models().vision,
    temperature: 0,
    max_tokens: 900,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: VISION_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Screenshot from the candidate display. Extract the visible interview problem only. Ignore any HUD overlay.",
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
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return null;
  return parseAnalysis(raw);
}
