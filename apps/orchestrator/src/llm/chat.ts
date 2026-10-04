import { client, currentAi, isClaude, models } from "./client.js";

export async function* streamChat(input: {
  system: string;
  user: string;
  model: string;
  temperature: number;
  maxTokens: number;
}): AsyncGenerator<string, { inputTokens: number; outputTokens: number }> {
  const creds = currentAi();
  if (!creds?.apiKey) throw new Error("No model key.");
  if (isClaude(creds)) {
    return yield* streamClaude(creds.apiKey, creds.baseURL, input);
  }
  const openai = client();
  if (!openai) throw new Error("No model key.");
  const stream = await openai.chat.completions.create({
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
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
  const completion = await openai.chat.completions.create({
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    response_format: input.json ? { type: "json_object" } : undefined,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  });
  return (completion.choices[0]?.message?.content ?? "").trim();
}

function unwrapJson(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function claudeUrl(baseURL?: string) {
  const root = (baseURL || "https://api.anthropic.com").replace(/\/$/, "");
  return `${root}/v1/messages`;
}

async function completeClaude(
  apiKey: string,
  baseURL: string | undefined,
  input: { system: string; user: string; model: string; temperature: number; maxTokens: number },
) {
  const res = await fetch(claudeUrl(baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model || models().fast,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(claudeError(res.status, body));
  }
  const json = (await res.json()) as {
    content?: { type?: string; text?: string }[];
  };
  return (json.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

async function* streamClaude(
  apiKey: string,
  baseURL: string | undefined,
  input: { system: string; user: string; model: string; temperature: number; maxTokens: number },
): AsyncGenerator<string, { inputTokens: number; outputTokens: number }> {
  const res = await fetch(claudeUrl(baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model || models().smart,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      system: input.system,
      stream: true,
      messages: [{ role: "user", content: input.user }],
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(claudeError(res.status, body));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inputTokens = 0;
  let outputTokens = 0;
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
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (event.type === "content_block_delta" && event.delta?.text) {
          yield event.delta.text;
        }
        if (event.usage) {
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
      } catch {
        /* ignore keep-alives */
      }
    }
  }
  return { inputTokens, outputTokens };
}

function claudeError(status: number, body: string) {
  if (status === 401) return "Claude rejected the key. Check it on the Plan page.";
  if (status === 429) return "Claude is rate-limiting this key. Try again in a moment.";
  const snippet = body.replace(/\s+/g, " ").slice(0, 160);
  return snippet || `Claude request failed (${status}).`;
}
