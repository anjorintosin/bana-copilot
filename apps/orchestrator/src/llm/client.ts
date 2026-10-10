import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";

export type AiProvider = "openai" | "claude" | "grok";

export type AiCreds = {
  apiKey: string;
  baseURL?: string;
  source: "hosted" | "byok" | "env";
  provider?: AiProvider;
};

export function inferProvider(creds: Pick<AiCreds, "apiKey" | "provider" | "baseURL">): AiProvider {
  if (creds.apiKey.startsWith("sk-ant-") || creds.provider === "claude" || String(creds.provider) === "anthropic") {
    return "claude";
  }
  if (creds.apiKey.startsWith("xai-") || creds.provider === "grok" || String(creds.provider) === "xai") {
    return "grok";
  }
  if (creds.provider === "openai") return "openai";
  const base = creds.baseURL || "";
  if (base.includes("anthropic.com")) return "claude";
  if (base.includes("x.ai")) return "grok";
  return "openai";
}

export function isClaude(creds?: AiCreds | null) {
  return Boolean(creds && inferProvider(creds) === "claude");
}

export function isGrok(creds?: AiCreds | null) {
  return Boolean(creds && inferProvider(creds) === "grok");
}

export function providerHasStt(creds?: AiCreds | null) {
  if (!creds?.apiKey) return false;
  const provider = inferProvider(creds);
  return provider !== "claude" && provider !== "grok";
}

const store = new AsyncLocalStorage<AiCreds>();
const hostedCache = new Map<string, OpenAI>();

export function runWithAi<T>(creds: AiCreds | null | undefined, fn: () => T): T {
  if (!creds?.apiKey) return fn();
  return store.run(creds, fn);
}

export const NEED_KEY = "Add your model key on the Plan page to try Bana Copilot.";

export function currentAi(): AiCreds | null {
  const local = store.getStore();
  if (local?.apiKey) return local;
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? { apiKey: key, source: "env" } : null;
}

export function currentAiKey() {
  return currentAi()?.apiKey ?? "";
}

function cacheKey(creds: AiCreds) {
  return `${creds.source}:${creds.baseURL ?? ""}:${creds.apiKey.slice(0, 8)}:${creds.apiKey.slice(-4)}`;
}

/** One reused client per process/key so TCP/TLS setup is not paid per answer. */
export function client() {
  const creds = currentAi();
  if (!creds?.apiKey) return null;
  if (isClaude(creds)) return null;
  const key = cacheKey(creds);
  const hit = hostedCache.get(key);
  if (hit) return hit;
  const created = new OpenAI({
    apiKey: creds.apiKey,
    baseURL: openAiBaseURL(creds),
  });
  hostedCache.set(key, created);
  return created;
}

function openAiBaseURL(creds: AiCreds) {
  if (creds.baseURL) return creds.baseURL;
  const provider = inferProvider(creds);
  if (provider === "grok") return "https://api.x.ai/v1";
  return undefined;
}

export function models() {
  const creds = currentAi();
  const provider = creds ? inferProvider(creds) : "openai";
  if (provider === "claude") {
    const fallback = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
    return {
      fast: process.env.CLAUDE_MODEL_FAST ?? process.env.CLAUDE_MODEL_NANO ?? "claude-haiku-4-5",
      smart: process.env.CLAUDE_MODEL_SMART ?? fallback,
      nano: process.env.CLAUDE_MODEL_NANO ?? "claude-haiku-4-5",
      vision: process.env.CLAUDE_VISION_MODEL ?? fallback,
      stt: "",
      embed: "",
    };
  }
  if (provider === "grok") {
    const fallback = process.env.GROK_MODEL ?? "grok-4.7";
    return {
      fast: process.env.GROK_MODEL_FAST ?? process.env.GROK_MODEL_NANO ?? "grok-4.3",
      smart: process.env.GROK_MODEL_SMART ?? fallback,
      nano: process.env.GROK_MODEL_NANO ?? "grok-4.3",
      vision: process.env.GROK_VISION_MODEL ?? fallback,
      stt: "",
      embed: "",
    };
  }
  const fallback = process.env.OPENAI_MODEL;
  return {
    fast: process.env.OPENAI_MODEL_FAST ?? fallback ?? "gpt-5.4-mini",
    smart: process.env.OPENAI_MODEL_SMART ?? fallback ?? "gpt-5.4",
    nano: process.env.OPENAI_MODEL_NANO ?? "gpt-4.1-mini",
    vision: process.env.OPENAI_VISION_MODEL ?? fallback ?? "gpt-5.4-mini",
    stt: process.env.OPENAI_STT_MODEL ?? "gpt-live-transcribe",
    embed: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
  };
}

/** Older keys or unverified orgs may not see the newest models. */
const OPENAI_FALLBACKS = ["gpt-5.4-mini", "gpt-4.1", "gpt-4o-mini"];

export function openAiModelChain(preferred: string) {
  return [...new Set([preferred, ...OPENAI_FALLBACKS].filter(Boolean))];
}

export function isReasoningModel(model: string) {
  return /^(gpt-5|o\d)/.test(model) && !/chat-latest/.test(model);
}

/** GPT-5 / o-series reject temperature and max_tokens; reasoning tokens share the output budget. */
export type ReasoningEffort = "none" | "low" | "medium";

export function openAiSampling(
  model: string,
  temperature: number,
  maxTokens: number,
  effort: ReasoningEffort = "low",
  verbosity?: "low" | "medium",
  priority = false,
) {
  if (isReasoningModel(model)) {
    return {
      max_completion_tokens: maxTokens + (effort === "medium" ? 6000 : effort === "low" ? 4000 : 0),
      reasoning_effort: effort as "low",
      ...(verbosity ? { verbosity } : {}),
      // The installed SDK types predate the "priority" tier; the API accepts it.
      ...(priority ? { service_tier: "priority" as unknown as "auto" } : {}),
    };
  }
  return { temperature, max_tokens: maxTokens };
}

let priorityRejected = false;

/** Priority processing roughly halves answer time; OPENAI_SERVICE_TIER=default turns it off. */
export function usePriorityTier() {
  return !priorityRejected && process.env.OPENAI_SERVICE_TIER !== "default";
}

export function markPriorityRejected(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/service[_ ]tier|priority/i.test(msg)) return false;
  priorityRejected = true;
  return true;
}

export function isModelUnavailable(err: unknown) {
  const status =
    typeof err === "object" && err && "status" in err ? Number((err as { status?: number }).status) : 0;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    status === 404 ||
    /model[_ ]not[_ ]found|does not exist|unknown model|invalid[_ ]model|do(es)? not have access|must be verified|unsupported (parameter|value)/i.test(
      msg,
    )
  );
}

export function pickAnswerModel(opts: { smart?: boolean; writesCode?: boolean }) {
  const { fast, smart } = models();
  return opts.smart || opts.writesCode ? smart : fast;
}

export function aiStatus() {
  const creds = currentAi();
  const provider = creds ? inferProvider(creds) : "none";
  const named = provider === "claude" || provider === "grok" ? provider : null;
  return {
    stt: providerHasStt(creds),
    llm: Boolean(creds?.apiKey),
    provider: named ?? (creds?.source === "byok" ? "byok" : creds?.apiKey ? "hosted" : "none"),
    models: models(),
  };
}
