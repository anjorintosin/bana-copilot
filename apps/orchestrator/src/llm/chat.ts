import {
  client,
  currentAi,
  isClaude,
  isGrok,
  isModelUnavailable,
  markPriorityRejected,
  openAiModelChain,
  openAiSampling,
  type ReasoningEffort,
  usePriorityTier,
} from "./client.js";
import { rawBase64 } from "./vision.js";

export type ChatImage = {
  base64: string;
  mimeType?: string;
  detail?: "low" | "high";
};

type ChatInput = {
  system: string;
  user: string;
  model: string;
  temperature: number;
  maxTokens: number;
  image?: ChatImage;
  reasoningEffort?: ReasoningEffort;
  verbosity?: "low" | "medium";
};

function imageMime(image?: ChatImage) {
  return image?.mimeType?.includes("png") ? "image/png" : "image/jpeg";
}

function openAiUserContent(input: ChatInput) {
  if (!input.image?.base64) return input.user;
  const mime = imageMime(input.image);
  return [
    { type: "text" as const, text: input.user },
    {
      type: "image_url" as const,
      image_url: {
        url: `data:${mime};base64,${rawBase64(input.image.base64)}`,
        detail: input.image.detail ?? "high",
      },
    },
  ];
}

function claudeUserContent(input: ChatInput) {
  if (!input.image?.base64) return input.user;
  const mime = imageMime(input.image);
  return [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mime,
        data: rawBase64(input.image.base64),
      },
    },
    { type: "text", text: input.user },
  ];
}

export async function* streamChat(input: ChatInput): AsyncGenerator<
  string,
  { inputTokens: number; outputTokens: number }
> {
  const creds = currentAi();
  if (!creds?.apiKey) throw new Error("No model key.");
  if (isClaude(creds)) {
    return yield* streamClaude(creds.apiKey, creds.baseURL, input);
  }
  const openai = client();
  if (!openai) throw new Error("No model key.");
  const grok = isGrok(creds);
  let last = "Grok request failed.";
  const models = chatModels(input.model, grok);
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const priority = !grok && usePriorityTier();
    try {
      const stream = await openai.chat.completions.create({
        model,
        stream: true,
        ...(grok
          ? { temperature: input.temperature, max_tokens: input.maxTokens }
          : openAiSampling(model, input.temperature, input.maxTokens, input.reasoningEffort, input.verbosity, priority)),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: openAiUserContent(input) },
        ],
        ...(grok ? {} : { stream_options: { include_usage: true as const } }),
      });
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const part of stream) {
        const delta = part.choices[0]?.delta?.content;
        if (delta) yield delta;
        if (part.usage) {
          inputTokens = part.usage.prompt_tokens ?? 0;
          outputTokens = part.usage.completion_tokens ?? 0;
        }
      }
      return { inputTokens, outputTokens };
    } catch (err) {
      last = err instanceof Error ? err.message : last;
      if (priority && markPriorityRejected(err)) {
        console.warn("[chat] priority tier rejected; retrying on the default tier");
        i -= 1;
        continue;
      }
      if (!isModelUnavailable(err)) throw err instanceof Error ? err : new Error(last);
      console.warn(`[chat] ${model} unavailable, trying next model`);
    }
  }
  throw new Error(last);
}

export async function completeChat(input: {
  system: string;
  user: string;
  model: string;
  temperature: number;
  maxTokens: number;
  json?: boolean;
}): Promise<string> {
  const creds = currentAi();
  if (!creds?.apiKey) return "";
  if (isClaude(creds)) {
    const raw = await completeClaude(creds.apiKey, creds.baseURL, {
      ...input,
      user: input.json ? `${input.user}\n\nReturn JSON only.` : input.user,
    });
    return input.json ? unwrapJson(raw) : raw;
  }
  const openai = client();
  if (!openai) return "";
  const grok = isGrok(creds);
  const jsonViaPrompt = grok && input.json;
  let last = "";
  for (const model of chatModels(input.model, grok)) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        ...(grok
          ? { temperature: input.temperature, max_tokens: input.maxTokens }
          : openAiSampling(model, input.temperature, input.maxTokens)),
        response_format: input.json && !jsonViaPrompt ? { type: "json_object" } : undefined,
        messages: [
          { role: "system", content: input.system },
          {
            role: "user",
            content: jsonViaPrompt ? `${input.user}\n\nReturn JSON only.` : openAiUserContent(input),
          },
        ],
      });
      const raw = (completion.choices[0]?.message?.content ?? "").trim();
      return input.json ? unwrapJson(raw) : raw;
    } catch (err) {
      last = err instanceof Error ? err.message : last;
      if (!isModelUnavailable(err)) throw err instanceof Error ? err : new Error(last);
    }
  }
  throw new Error(last || "Model request failed.");
}

function unwrapJson(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

const GROK_FALLBACKS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4",
  "grok-3-mini",
];

function chatModels(preferred: string, grok: boolean) {
  if (!grok) return openAiModelChain(preferred);
  return [...new Set([preferred, ...GROK_FALLBACKS].filter(Boolean))];
}

function claudeUrl(baseURL?: string) {
  const root = (baseURL || "https://api.anthropic.com").replace(/\/$/, "").replace(/\/v1$/, "");
  return `${root}/v1/messages`;
}

const CLAUDE_FALLBACKS = [
  "claude-haiku-4-5",
  "claude-sonnet-5-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
];

function claudeModels(preferred?: string) {
  return [...new Set([preferred, ...CLAUDE_FALLBACKS].filter(Boolean) as string[])];
}

async function postClaude(
  apiKey: string,
  baseURL: string | undefined,
  input: ChatInput,
  stream: boolean,
) {
  let last = "Claude request failed.";
  for (const model of claudeModels(input.model)) {
    const res = await fetch(claudeUrl(baseURL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(16, input.maxTokens || 256),
        temperature: input.temperature,
        system: input.system,
        stream,
        messages: [{ role: "user", content: claudeUserContent(input) }],
      }),
    });
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    last = claudeError(res.status, body);
    if (res.status === 401 || res.status === 403) throw new Error(last);
    const notModel = res.status === 404 || /not_found|invalid_request.*model/i.test(body);
    if (!notModel) throw new Error(last);
  }
  throw new Error(last);
}

async function completeClaude(
  apiKey: string,
  baseURL: string | undefined,
  input: ChatInput,
) {
  const res = await postClaude(apiKey, baseURL, input, false);
  const json = (await res.json()) as {
    content?: { type?: string; text?: string }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(claudeError(400, json.error.message));
  return (json.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

async function* streamClaude(
  apiKey: string,
  baseURL: string | undefined,
  input: ChatInput,
): AsyncGenerator<string, { inputTokens: number; outputTokens: number }> {
  const res = await postClaude(apiKey, baseURL, input, true);
  if (!res.body) {
    const text = await completeClaude(apiKey, baseURL, input);
    if (text) yield text;
    return { inputTokens: 0, outputTokens: 0 };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let yielded = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { type?: string; message?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (event.type === "error" || event.error?.message) {
          throw new Error(claudeError(400, event.error?.message ?? data));
        }
        if (event.type === "content_block_delta" && event.delta?.text) {
          yielded += event.delta.text;
          yield event.delta.text;
        }
        if (event.usage) {
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
  if (!yielded.trim()) {
    const text = await completeClaude(apiKey, baseURL, input);
    if (text) yield text;
  }
  return { inputTokens, outputTokens };
}

function claudeError(status: number, body: string) {
  if (status === 401 || status === 403) {
    return "Claude rejected the key. Use an API key from console.anthropic.com, not a chat login token.";
  }
  if (status === 429) return "Claude is rate-limiting this key. Try again in a moment.";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
    const msg = parsed.error?.message || parsed.error?.type;
    if (msg) return `Claude: ${msg}`;
  } catch {
    /* raw body */
  }
  const snippet = body.replace(/\s+/g, " ").slice(0, 160);
  return snippet ? `Claude: ${snippet}` : `Claude request failed (${status}).`;
}
