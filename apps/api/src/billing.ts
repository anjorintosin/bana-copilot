import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  allowlist,
  sanitizeSecret,
  type AccountPlan,
  type BillingAccount,
  type BillingPlan,
} from "@meeting-copilot/types";
import { pool } from "./db.js";
import { verifyModelKey } from "@meeting-copilot/orchestrator";

const SEED: {
  id: string;
  name: string;
  kind: "hosted" | "byok";
  price_cents: number;
  blurb: string;
  features: string[];
  ordinal: number;
}[] = [
  {
    id: "hosted",
    name: "Hosted AI",
    kind: "hosted",
    price_cents: 3000,
    blurb: "Paused for testers. Use your own model key on this page for now.",
    features: [
      "Interview HUD and story bank",
      "Hosted models are off while we test",
      "Practice drills against this role",
      "Add a key below to run answers",
    ],
    ordinal: 0,
  },
  {
    id: "byok",
    name: "Your key",
    kind: "byok",
    price_cents: 1500,
    blurb: "Bring your own model key. We never spend ours on your sessions.",
    features: [
      "Interview HUD and story bank",
      "You pay your model provider directly",
      "Claude, Grok, or OpenAI",
      "Lower monthly price",
    ],
    ordinal: 1,
  },
];

export type AiCreds = {
  apiKey: string;
  baseURL?: string;
  source: "hosted" | "byok" | "env";
  provider?: "openai" | "claude" | "grok";
};

export type AiResolve =
  | { ok: true; creds: AiCreds }
  | { ok: false; code: string; message: string };

function stripeSecret() {
  return process.env.STRIPE_SECRET_KEY?.trim() || "";
}

export function stripeEnabled() {
  return Boolean(stripeSecret());
}

function stripe() {
  const key = stripeSecret();
  if (!key) return null;
  return new Stripe(key);
}

function appUrl() {
  return (process.env.PUBLIC_APP_URL || `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(
    /\/$/,
    "",
  );
}

function credsSecret() {
  return createHash("sha256")
    .update(process.env.CREDENTIALS_SECRET || process.env.JWT_SECRET || "dev-only-change-me")
    .digest();
}

function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credsSecret(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    cipher: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(row: { cipher: string; iv: string; tag: string }) {
  const dec = createDecipheriv(
    "aes-256-gcm",
    credsSecret(),
    Buffer.from(row.iv, "base64"),
  );
  dec.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([
    dec.update(Buffer.from(row.cipher, "base64")),
    dec.final(),
  ]).toString("utf8");
}

function priceLabel(cents: number) {
  return `$${(cents / 100).toFixed(0)}/mo`;
}

function asPlan(row: {
  id: string;
  name: string;
  kind: string;
  price_cents: number;
  blurb: string;
  features: unknown;
}): BillingPlan {
  const features = Array.isArray(row.features)
    ? row.features.map((item) => String(item))
    : [];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "byok" ? "byok" : "hosted",
    priceCents: row.price_cents,
    priceLabel: priceLabel(row.price_cents),
    interval: "month",
    blurb: row.blurb,
    features,
  };
}

export async function seedBillingPlans() {
  for (const plan of SEED) {
    await pool.query(
      `INSERT INTO billing_plans
         (id, name, kind, price_cents, blurb, features, ordinal)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         price_cents = excluded.price_cents,
         blurb = excluded.blurb,
         features = excluded.features,
         ordinal = excluded.ordinal`,
      [
        plan.id,
        plan.name,
        plan.kind,
        plan.price_cents,
        plan.blurb,
        JSON.stringify(plan.features),
        plan.ordinal,
      ],
    );
  }
}

async function listPlans(): Promise<BillingPlan[]> {
  const result = await pool.query(
    `SELECT id, name, kind, price_cents, blurb, features
     FROM billing_plans
     WHERE active = true
     ORDER BY ordinal ASC`,
  );
  return result.rows.map(asPlan);
}

function isActiveStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

function labelFor(planId: string | null | undefined, status: string | null | undefined) {
  if (!isActiveStatus(status)) return "Free";
  if (planId === "byok") return "Your key";
  if (planId === "hosted" || planId === "pro") return "Hosted AI";
  return "Free";
}

export async function getBillingAccount(userId: string): Promise<BillingAccount> {
  const [plans, sub, key] = await Promise.all([
    listPlans(),
    pool.query(
      `SELECT plan_id, status, current_period_end
       FROM subscriptions WHERE user_id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT llm_provider, llm_key_last4, llm_base_url, llm_key_cipher
       FROM user_profiles WHERE user_id = $1`,
      [userId],
    ),
  ]);
  const row = sub.rows[0];
  const status = isActiveStatus(row?.status) ? "active" : (row?.status as BillingAccount["status"]) || "free";
  const planId = (isActiveStatus(row?.status) ? row.plan_id : "free") as AccountPlan;
  const current = plans.find((plan) => plan.id === row?.plan_id);
  const keyRow = key.rows[0];
  return {
    plan: planId === "pro" ? "hosted" : planId,
    label: labelFor(row?.plan_id, row?.status),
    status: status === "active" ? "active" : status === "free" ? "free" : status,
    renewsAt: row?.current_period_end
      ? new Date(row.current_period_end).toISOString()
      : null,
    features: current?.features ?? [
      "Interview HUD",
      "Resume + role brief",
      "Session history",
    ],
    stripeEnabled: stripeEnabled(),
    key: {
      configured: Boolean(keyRow?.llm_key_cipher),
      provider: keyRow?.llm_provider ?? null,
      last4: keyRow?.llm_key_last4 ?? null,
      baseUrl: keyRow?.llm_base_url ?? null,
    },
    catalog: plans,
  };
}

async function upsertSubscription(
  userId: string,
  input: {
    planId: string;
    status: string;
    customerId?: string | null;
    subscriptionId?: string | null;
    checkoutId?: string | null;
    periodEnd?: Date | null;
  },
) {
  await pool.query(
    `INSERT INTO subscriptions
       (id, user_id, plan_id, status, stripe_customer_id, stripe_subscription_id,
        stripe_checkout_id, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET
       plan_id = excluded.plan_id,
       status = excluded.status,
       stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
       stripe_checkout_id = COALESCE(excluded.stripe_checkout_id, subscriptions.stripe_checkout_id),
       current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end),
       updated_at = now()`,
    [
      randomUUID(),
      userId,
      input.planId,
      input.status,
      input.customerId ?? null,
      input.subscriptionId ?? null,
      input.checkoutId ?? null,
      input.periodEnd ?? null,
    ],
  );
  await pool.query(
    `INSERT INTO user_profiles (user_id, plan, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET
       plan = excluded.plan,
       updated_at = now()`,
    [userId, isActiveStatus(input.status) ? input.planId : "free"],
  );
}

export async function createCheckout(userId: string, planId: string) {
  const allowed = allowlist(planId, ["hosted", "byok"] as const);
  const plan = (await listPlans()).find((item) => item.id === allowed);
  if (!plan) throw new Error("Unknown plan.");
  const client = stripe();
  if (!client) {
    throw new Error("Add STRIPE_SECRET_KEY to .env to take payments.");
  }

  const existing = await pool.query(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  const session = await client.checkout.sessions.create({
    mode: "subscription",
    success_url: `${appUrl()}/billing/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/billing/cancel`,
    client_reference_id: userId,
    customer: existing.rows[0]?.stripe_customer_id || undefined,
    metadata: { userId, planId: plan.id },
    subscription_data: { metadata: { userId, planId: plan.id } },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: plan.priceCents,
          recurring: { interval: "month" },
          product_data: {
            name: `Bana Copilot — ${plan.name}`,
            description: plan.blurb,
          },
        },
      },
    ],
  });
  await upsertSubscription(userId, {
    planId: plan.id,
    status: "inactive",
    checkoutId: session.id,
    customerId: typeof session.customer === "string" ? session.customer : null,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return { url: session.url };
}

export async function completeCheckout(sessionId: string) {
  const client = stripe();
  if (!client) throw new Error("Stripe is not configured.");
  const session = await client.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });
  const userId = session.metadata?.userId || session.client_reference_id;
  const planId = session.metadata?.planId;
  if (!userId || !planId) throw new Error("Checkout session is missing plan metadata.");
  if (session.status !== "complete" && session.payment_status === "unpaid") {
    throw new Error("Payment is not complete yet.");
  }
  const sub = session.subscription;
  const subId = typeof sub === "string" ? sub : sub?.id;
  const periodEnd =
    typeof sub === "object" && sub && "current_period_end" in sub && sub.current_period_end
      ? new Date(Number(sub.current_period_end) * 1000)
      : null;
  await upsertSubscription(userId, {
    planId,
    status: "active",
    customerId: typeof session.customer === "string" ? session.customer : null,
    subscriptionId: subId ?? null,
    checkoutId: session.id,
    periodEnd,
  });
  return { userId, planId };
}

/** Local-only: flip the plan without Stripe when no secret is set. */
export async function activateLocally(userId: string, planId: string) {
  if (stripeEnabled()) {
    throw new Error("Stripe is configured. Use checkout.");
  }
  const allowed = allowlist(planId, ["hosted", "byok"] as const);
  const plan = (await listPlans()).find((item) => item.id === allowed);
  if (!plan) throw new Error("Unknown plan.");
  await upsertSubscription(userId, {
    planId: plan.id,
    status: "active",
    periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return getBillingAccount(userId);
}

export async function saveUserModelKey(
  userId: string,
  input: { provider?: string; apiKey?: string; baseUrl?: string },
) {
  const apiKey = sanitizeSecret(input.apiKey);
  let provider = allowlist(
    input.provider || "openai",
    ["openai", "claude", "grok", "anthropic", "xai"] as const,
    "openai",
  );
  if (apiKey.startsWith("sk-ant-") || provider === "anthropic") provider = "claude";
  if (apiKey.startsWith("xai-") || provider === "xai") provider = "grok";
  const baseUrl =
    provider === "grok"
      ? "https://api.x.ai/v1"
      : provider === "claude"
        ? "https://api.anthropic.com"
        : "";
  await verifyModelKey({ apiKey, baseURL: baseUrl || undefined, provider });
  const packed = encryptSecret(apiKey);
  const last4 = apiKey.slice(-4);
  await pool.query(
    `INSERT INTO user_profiles
       (user_id, llm_provider, llm_key_cipher, llm_key_iv, llm_key_tag, llm_base_url, llm_key_last4, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id) DO UPDATE SET
       llm_provider = excluded.llm_provider,
       llm_key_cipher = excluded.llm_key_cipher,
       llm_key_iv = excluded.llm_key_iv,
       llm_key_tag = excluded.llm_key_tag,
       llm_base_url = excluded.llm_base_url,
       llm_key_last4 = excluded.llm_key_last4,
       updated_at = now()`,
    [userId, provider, packed.cipher, packed.iv, packed.tag, baseUrl || null, last4],
  );
  return getBillingAccount(userId);
}

export async function clearUserModelKey(userId: string) {
  await pool.query(
    `UPDATE user_profiles SET
       llm_provider = null, llm_key_cipher = null, llm_key_iv = null,
       llm_key_tag = null, llm_base_url = null, llm_key_last4 = null, updated_at = now()
     WHERE user_id = $1`,
    [userId],
  );
  return getBillingAccount(userId);
}

async function loadUserKey(userId: string): Promise<AiCreds | null> {
  const result = await pool.query(
    `SELECT llm_provider, llm_key_cipher, llm_key_iv, llm_key_tag, llm_base_url
     FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row?.llm_key_cipher || !row.llm_key_iv || !row.llm_key_tag) return null;
  try {
    const apiKey = decryptSecret({
      cipher: row.llm_key_cipher,
      iv: row.llm_key_iv,
      tag: row.llm_key_tag,
    });
    const provider = (row.llm_provider as AiCreds["provider"]) || undefined;
    const inferred =
      apiKey.startsWith("sk-ant-")
        ? "claude"
        : apiKey.startsWith("xai-")
          ? "grok"
          : provider === "grok" || provider === "claude"
            ? provider
            : "openai";
    const baseURL =
      inferred === "grok"
        ? "https://api.x.ai/v1"
        : inferred === "claude"
          ? "https://api.anthropic.com"
          : undefined;
    return {
      apiKey,
      baseURL,
      source: "byok",
      provider: inferred,
    };
  } catch {
    return null;
  }
}

export async function resolveAi(userId: string): Promise<AiResolve> {
  const creds = await loadUserKey(userId);
  if (creds) return { ok: true, creds };

  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return {
      ok: true,
      creds: {
        apiKey: envKey,
        source: "env",
        provider: envKey.startsWith("sk-ant-")
          ? "claude"
          : envKey.startsWith("xai-")
            ? "grok"
            : "openai",
      },
    };
  }

  return {
    ok: false,
    code: "need_key",
    message: "Server AI key is not configured. Please ensure OPENAI_API_KEY is set in the server environment.",
  };
}

export function billingCompleteHtml(ok: boolean, message: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bana Copilot</title>
<style>body{font-family:system-ui,sans-serif;background:#0c0c10;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:420px;padding:28px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:#14141a}
h1{font-size:22px;margin:0 0 8px}p{color:#a1a1aa;line-height:1.5}</style></head>
<body><main><h1>${ok ? "You're subscribed" : "Checkout"}</h1><p>${message}</p>
<p>Return to Home → Plan in the app.</p></main></body></html>`;
}
