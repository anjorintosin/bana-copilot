import { sanitizeLine, sanitizeText } from "@meeting-copilot/types";
import { NEED_KEY, client, models } from "./client.js";
import { VISION_PROMPT } from "./prompts.js";

export type ScreenKind = "code" | "slide" | "docs" | "browser" | "idle" | "other";

export type ScreenAnalysis = {
  kind: ScreenKind;
  title: string;
  ocrText: string;
  problem: string;
  needsHelp: boolean;
  confidence: number;
};

function rawBase64(data: string) {
  const trimmed = data.trim();
  const comma = trimmed.indexOf(",");
  if (trimmed.startsWith("data:") && comma >= 0) return trimmed.slice(comma + 1);
  return trimmed.replace(/\s/g, "");
}

export async function analyzeScreen(
  imageBase64: string,
  mimeType = "image/jpeg",
  opts: { detail?: "low" | "high" } = {},
): Promise<ScreenAnalysis | null> {
  const openai = client();
  if (!openai) {
    throw new Error(NEED_KEY);
  }
  const b64 = rawBase64(imageBase64);
  if (b64.length < 800) return null;
  const mime = mimeType.includes("png") ? "image/png" : "image/jpeg";
  const detail = opts.detail ?? "low";
  const completion = await openai.chat.completions.create({
    model: models().vision,
    temperature: 0,
    max_tokens: 280,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: VISION_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Screenshot from the candidate display. Extract interview content only.",
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
      title: sanitizeLine(parsed.title ?? "", 120),
      ocrText: sanitizeText(parsed.ocrText ?? "", { max: 800 }),
      problem: sanitizeText(parsed.problem ?? "", { max: 600 }),
      needsHelp: Boolean(parsed.needsHelp),
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  } catch {
    return null;
  }
}
