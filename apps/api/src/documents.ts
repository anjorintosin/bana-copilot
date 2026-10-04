import { randomUUID } from "node:crypto";
import {
  LIMITS,
  type AccountPlan,
  type DocumentKind,
  sanitizeLine,
  sanitizeText,
} from "@meeting-copilot/types";
import { pool } from "./db.js";
import { saveResume, textFromPdfBase64 } from "./resumes.js";

export const DOCUMENT_KIND_IDS: DocumentKind[] = ["resume", "job", "company", "notes"];

export type UserDocument = {
  id: string;
  kind: DocumentKind;
  title: string;
  excerpt: string;
  text: string;
  chars: number;
  createdAt: string;
};

function asKind(value: string): DocumentKind | null {
  return DOCUMENT_KIND_IDS.includes(value as DocumentKind)
    ? (value as DocumentKind)
    : null;
}

function toDoc(row: {
  id: string;
  kind: string;
  title: string;
  raw_text: string;
  created_at: Date | string;
}): UserDocument {
  const text = String(row.raw_text ?? "");
  return {
    id: row.id,
    kind: (asKind(row.kind) ?? "notes") as DocumentKind,
    title: row.title,
    excerpt: text.replace(/\s+/g, " ").trim().slice(0, 280),
    text,
    chars: text.length,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listDocuments(userId: string) {
  const result = await pool.query(
    `SELECT id, kind, title, raw_text, created_at
     FROM user_documents
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 40`,
    [userId],
  );
  const recent = result.rows.map(toDoc);
  const latest: Partial<Record<DocumentKind, UserDocument>> = {};
  for (const doc of recent) {
    if (!latest[doc.kind]) latest[doc.kind] = doc;
  }
  return { latest, recent };
}

export async function latestDocument(userId: string, kind: DocumentKind) {
  const result = await pool.query(
    `SELECT id, kind, title, raw_text, created_at
     FROM user_documents
     WHERE user_id = $1 AND kind = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, kind],
  );
  return result.rows[0] ? toDoc(result.rows[0]) : null;
}

export async function saveDocument(
  userId: string,
  input: {
    kind: string;
    title?: string;
    text?: string;
    pdfBase64?: string;
  },
) {
  const kind = asKind(input.kind);
  if (!kind) throw new Error("Unknown document kind.");
  const text = input.pdfBase64
    ? await textFromPdfBase64(input.pdfBase64)
    : sanitizeText(input.text ?? "", { max: LIMITS.document });
  const min = kind === "notes" ? 12 : 40;
  if (text.length < min) {
    throw new Error(`Add a bit more ${kind} text, or upload a PDF.`);
  }
  const title =
    sanitizeLine(input.title ?? "", LIMITS.title) ||
    (kind === "resume"
      ? "Resume"
      : kind === "job"
        ? "Job posting"
        : kind === "company"
          ? "Company notes"
          : "Notes");

  await pool.query(
    `INSERT INTO user_documents (id, user_id, kind, title, raw_text)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), userId, kind, title, text],
  );

  if (kind === "resume") {
    await saveResume(userId, text, title);
  }

  return listDocuments(userId);
}

/** @deprecated Use getBillingAccount. Kept so older callers still compile. */
export function accountFromPlan(plan: string | null | undefined) {
  const current: AccountPlan = plan === "pro" ? "pro" : "free";
  return {
    plan: current,
    label: current === "pro" ? "Pro" : "Free",
    status: "active",
    renewsAt: null as string | null,
    features:
      current === "pro"
        ? ["Unlimited sessions", "Smart Mode", "Document library", "Priority answers"]
        : ["Interview HUD", "Resume + role brief", "Session history"],
    upgrade: {
      id: "pro",
      label: "Pro",
      price: "$20/mo",
      comingSoon: true,
      blurb: "Billing will land here — this page is ready for Stripe later.",
      features: [
        "Unlimited saved sessions",
        "Smart Mode on every track",
        "Job + company documents in every answer",
        "Priority model when the interview is live",
      ],
    },
  };
}
