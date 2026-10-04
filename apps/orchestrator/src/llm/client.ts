import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";

export type AiProvider = "openai" | "claude" | "groq" | "compatible";

export type AiCreds = {
  apiKey: string;
  baseURL?: string;
  source: "hosted" | "byok" | "env";
  provider?: AiProvider;
};

export function inferProvider(creds: Pick<AiCreds, "apiKey" | "provider" | "baseURL">): AiProvider {
  if (creds.provider === "claude" || String(creds.provider) === "anthropic") return "claude";
  if (creds.provider === "groq") return "groq";
  if (creds.provider === "compatible") return "compatible";
  if (creds.provider === "openai") return "openai";
  if (creds.apiKey.startsWith("sk-ant-")) return "claude";
  if ((creds.baseURL || "").includes("anthropic.com")) return "claude";
  if ((creds.baseURL || "").includes("groq.com")) return "groq";
  return "openai";
}

export function isClaude(creds?: AiCreds | null) {
  return Boolean(creds && inferProvider(creds) === "claude");
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
  if (process.env.NODE_ENV === "production") return null;
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
    baseURL: creds.baseURL || undefined,
  });
  hostedCache.set(key, created);
  return created;
}

export function models() {
  const creds = currentAi();
  if (isClaude(creds)) {
    const fallback = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5";
    return {
      fast: process.env.CLAUDE_MODEL_FAST ?? process.env.CLAUDE_MODEL_NANO ?? "claude-haiku-4-5",
      smart: process.env.CLAUDE_MODEL_SMART ?? fallback,
      nano: process.env.CLAUDE_MODEL_NANO ?? "claude-haiku-4-5",
      vision: process.env.CLAUDE_VISION_MODEL ?? fallback,
      stt: "",
      embed: "",
    };
  }
  const fallback = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  return {
    fast: process.env.OPENAI_MODEL_FAST ?? fallback,
    smart: process.env.OPENAI_MODEL_SMART ?? fallback,
    nano: process.env.OPENAI_MODEL_NANO ?? fallback,
    vision:
      process.env.OPENAI_VISION_MODEL ??
      process.env.OPENAI_MODEL_FAST ??
      fallback,
    stt: process.env.OPENAI_STT_MODEL ?? "gpt-live-transcribe",
    embed: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small",
  };
}

export function pickAnswerModel(opts: { smart?: boolean; writesCode?: boolean }) {
  const { fast, smart } = models();
  return opts.smart || opts.writesCode ? smart : fast;
}

export function aiStatus() {
  const creds = currentAi();
  const claude = isClaude(creds);
  return {
    stt: Boolean(creds?.apiKey) && !claude,
    llm: Boolean(creds?.apiKey),
    provider: claude
      ? "claude"
      : creds?.source === "byok"
        ? "byok"
        : creds?.apiKey
          ? "hosted"
          : "none",
    models: models(),
  };
}
