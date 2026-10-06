import { inferProvider, type AiProvider } from "./client.js";

const TIMEOUT_MS = 12_000;
const ANTHROPIC_VERSION = "2023-06-01";

export async function verifyModelKey(creds: {
  apiKey: string;
  baseURL?: string;
  provider?: string;
}) {
  const provider = inferProvider(creds);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    if (provider === "claude") {
      await probeClaude(creds.apiKey, creds.baseURL, signal);
      return;
    }
    await probeOpenAiStyle(provider, creds.apiKey, creds.baseURL, signal);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error("Timed out checking this key. Try again.");
    }
    if (err instanceof TypeError) {
      throw new Error("Could not reach this provider. Try again.");
    }
    throw err;
  }
}

function claudeRoot(baseURL?: string) {
  return (baseURL || "https://api.anthropic.com").replace(/\/$/, "").replace(/\/v1$/, "");
}

function chatRoot(provider: AiProvider, baseURL?: string) {
  if (baseURL) {
    const root = baseURL.replace(/\/$/, "");
    return root.endsWith("/v1") ? root : `${root}/v1`;
  }
  if (provider === "grok") return "https://api.x.ai/v1";
  return "https://api.openai.com/v1";
}

function rejected(provider: AiProvider) {
  if (provider === "claude") {
    return "Claude rejected the key. Use an API key from console.anthropic.com, not a chat token.";
  }
  if (provider === "grok") return "Grok rejected this key. Use an API key from console.x.ai, not a grok.com login.";
  return "This key was rejected. Check it and try again.";
}

function billing(provider: AiProvider) {
  if (provider === "claude") return "This Claude account needs billing set up.";
  if (provider === "grok") return "This Grok account needs billing set up.";
  return "This account needs billing set up.";
}

function looksUnauthorized(status: number, body: string) {
  if (status === 401 || status === 403) return true;
  return /invalid[_ ]api[_ ]key|incorrect api key|authentication_error|invalid x-api-key|unauthorized/i.test(
    body,
  );
}

function decideList(provider: AiProvider, status: number, body: string): "ok" | "retry" {
  if (status === 429 || (status >= 200 && status < 300)) return "ok";
  if (status === 402) throw new Error(billing(provider));
  if (looksUnauthorized(status, body)) throw new Error(rejected(provider));
  if (status === 400 || status === 404) return "retry";
  throw new Error(`Could not verify this key (${status}).`);
}

function decidePing(provider: AiProvider, status: number, body: string) {
  if (status === 429 || (status >= 200 && status < 300)) return;
  if (status === 402) throw new Error(billing(provider));
  if (looksUnauthorized(status, body)) throw new Error(rejected(provider));
  if (status === 400) return;
  throw new Error(`Could not verify this key (${status}).`);
}

async function probeClaude(apiKey: string, baseURL: string | undefined, signal: AbortSignal) {
  const root = claudeRoot(baseURL);
  const listed = await fetch(`${root}/v1/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal,
  });
  const listedBody = listed.ok ? "" : await listed.text().catch(() => "");
  if (decideList("claude", listed.status, listedBody) === "ok") return;

  const ping = await fetch(`${root}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal,
  });
  const pingBody = ping.ok ? "" : await ping.text().catch(() => "");
  decidePing("claude", ping.status, pingBody);
}

async function probeOpenAiStyle(
  provider: AiProvider,
  apiKey: string,
  baseURL: string | undefined,
  signal: AbortSignal,
) {
  const root = chatRoot(provider, baseURL);
  const listed = await fetch(`${root}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  const listedBody = listed.ok ? "" : await listed.text().catch(() => "");
  if (decideList(provider, listed.status, listedBody) === "ok") return;

  const ping = await fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: provider === "grok" ? "grok-4.3" : "gpt-4o-mini",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal,
  });
  const pingBody = ping.ok ? "" : await ping.text().catch(() => "");
  decidePing(provider, ping.status, pingBody);
}
