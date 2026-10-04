import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  INTERVIEW_TRACKS,
  LIMITS,
  allowlist,
  sanitizeJobContext,
  sanitizeLine,
  sanitizeText,
} from "@meeting-copilot/types";
import { pool } from "./db.js";
import {
  chunkResume,
  embedTexts,
  formatCandidateBrief,
  formatStoryCatalog,
  rankChunks,
  runWithAi,
} from "@meeting-copilot/orchestrator";
import { resolveAi } from "./billing.js";
import { beginStoryExtract, listStories } from "./stories.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;

export type JobProfile = {
  title?: string | null;
  company?: string | null;
  requirements?: string | null;
};

export async function getProfile(userId: string) {
  const profile = await pool.query(
    `SELECT p.job_title, p.company, p.requirements, p.active_resume_id,
            p.default_track, p.plan, p.stories_status,
            r.title AS resume_title, r.raw_text,
            (SELECT count(*)::int FROM resume_chunks c WHERE c.resume_id = r.id) AS chunk_count,
            (SELECT count(*)::int FROM stories s WHERE s.user_id = p.user_id) AS story_count
     FROM user_profiles p
     LEFT JOIN resumes r ON r.id = p.active_resume_id
     WHERE p.user_id = $1`,
    [userId],
  );
  const row = profile.rows[0];
  if (!row) {
    return {
      jobTitle: "",
      company: "",
      requirements: "",
      defaultTrack: "auto",
      plan: "free",
      storiesStatus: "empty" as const,
      storyCount: 0,
      resume: null as null | {
        id: string;
        title: string;
        excerpt: string;
        chunkCount: number;
      },
    };
  }
  return {
    jobTitle: row.job_title ?? "",
    company: row.company ?? "",
    requirements: row.requirements ?? "",
    defaultTrack: (row.default_track as string) || "auto",
    plan: (row.plan as string) || "free",
    storiesStatus: (row.stories_status as string) || "empty",
    storyCount: row.story_count ?? 0,
    resume: row.active_resume_id
      ? {
          id: row.active_resume_id as string,
          title: (row.resume_title as string) ?? "Resume",
          excerpt: String(row.raw_text ?? "").slice(0, 280),
          chunkCount: row.chunk_count ?? 0,
        }
      : null,
  };
}

export async function saveProfile(
  userId: string,
  job: JobProfile & { defaultTrack?: string | null },
) {
  const cleaned = sanitizeJobContext(job);
  const track = job.defaultTrack
    ? allowlist(
        job.defaultTrack,
        INTERVIEW_TRACKS.map((item) => item.id),
        "auto",
      )
    : null;
  await pool.query(
    `INSERT INTO user_profiles (user_id, job_title, company, requirements, default_track, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'auto'), now())
     ON CONFLICT (user_id) DO UPDATE SET
       job_title = excluded.job_title,
       company = excluded.company,
       requirements = excluded.requirements,
       default_track = COALESCE(excluded.default_track, user_profiles.default_track),
       updated_at = now()`,
    [
      userId,
      cleaned.title,
      cleaned.company,
      cleaned.requirements,
      track,
    ],
  );
  return getProfile(userId);
}

export async function textFromPdfBase64(pdfBase64: string) {
  const buf = Buffer.from(pdfBase64, "base64");
  if (buf.length < 8) {
    throw new Error("PDF file is empty.");
  }
  if (buf.length > 8_000_000) {
    throw new Error("PDF is too large (max 8 MB).");
  }
  if (!buf.subarray(0, 5).toString("utf8").startsWith("%PDF")) {
    throw new Error("That file is not a valid PDF.");
  }
  const result = await pdfParse(buf);
  const text = sanitizeText(result.text, { max: LIMITS.document });
  if (text.length < 40) {
    throw new Error(
      "Could not read text from this PDF. If it is a scan, paste the text instead.",
    );
  }
  return text;
}

export async function saveResume(userId: string, rawText: string, title = "Resume") {
  const text = sanitizeText(rawText, { max: LIMITS.document });
  const safeTitle = sanitizeLine(title, LIMITS.title) || "Resume";
  if (text.length < 40) {
    throw new Error("Resume is too short to index.");
  }
  const chunks = chunkResume(text);
  if (!chunks.length) {
    throw new Error("Could not split the resume into passages.");
  }
  const resolved = await resolveAi(userId);
  const embeddings = resolved.ok
    ? await runWithAi(resolved.creds, () => embedTexts(chunks))
    : await embedTexts(chunks);
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO resumes (id, user_id, title, raw_text) VALUES ($1, $2, $3, $4)`,
      [id, userId, safeTitle, text],
    );
    for (let i = 0; i < chunks.length; i += 1) {
      await client.query(
        `INSERT INTO resume_chunks (id, resume_id, ordinal, text, embedding)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [randomUUID(), id, i, chunks[i], JSON.stringify(embeddings[i])],
      );
    }
    await client.query(
      `INSERT INTO user_profiles (user_id, active_resume_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET
         active_resume_id = excluded.active_resume_id,
         updated_at = now()`,
      [userId, id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  beginStoryExtract(userId, id, text);
  return getProfile(userId);
}

export async function getCandidateBrief(userId: string) {
  const result = await pool.query(
    `SELECT p.job_title, p.company, p.requirements, r.raw_text
     FROM user_profiles p
     LEFT JOIN resumes r ON r.id = p.active_resume_id
     WHERE p.user_id = $1`,
    [userId],
  );
  const extras = await pool.query(
    `SELECT DISTINCT ON (kind) kind, raw_text
     FROM user_documents
     WHERE user_id = $1 AND kind IN ('job', 'company')
     ORDER BY kind, created_at DESC`,
    [userId],
  );
  const extra: Record<string, string> = {};
  for (const item of extras.rows) extra[item.kind] = item.raw_text;
  const row = result.rows[0];
  const stories = await listStories(userId);
  const job = {
    title: (row?.job_title as string | null) ?? null,
    company: (row?.company as string | null) ?? null,
    requirements: (row?.requirements as string | null) ?? null,
  };
  return {
    job,
    stories,
    brief: formatCandidateBrief({
      title: job.title,
      company: job.company,
      requirements: job.requirements,
      resumeExcerpt: (row?.raw_text as string | null) ?? "",
      jobPosting: extra.job ?? "",
      companyNotes: extra.company ?? "",
      storyCatalog: formatStoryCatalog(stories),
    }),
  };
}

export async function retrieveResumeContext(
  userId: string,
  question: string,
  opts: { k?: number } = {},
) {
  const profile = await pool.query(
    `SELECT active_resume_id, job_title, company, requirements
     FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  const row = profile.rows[0];
  const job = {
    title: row?.job_title ?? null,
    company: row?.company ?? null,
    requirements: row?.requirements ?? null,
  };
  if (!row?.active_resume_id) {
    return { job, context: "" };
  }
  const chunks = await pool.query(
    `SELECT text, embedding FROM resume_chunks WHERE resume_id = $1 ORDER BY ordinal`,
    [row.active_resume_id],
  );
  if (!chunks.rows.length) return { job, context: "" };
  const resolved = await resolveAi(userId);
  const [query] = resolved.ok
    ? await runWithAi(resolved.creds, () => embedTexts([question]))
    : [[] as number[]];
  const mapped = chunks.rows.map((item) => ({
    text: item.text as string,
    embedding: Array.isArray(item.embedding)
      ? (item.embedding as number[])
      : (JSON.parse(String(item.embedding || "[]")) as number[]),
  }));
  const ranked = query.length
    ? rankChunks(query, mapped, opts.k ?? 2)
    : mapped.slice(0, opts.k ?? 2).map((item) => ({ text: item.text, score: 1 }));
  return {
    job,
    context: ranked
      .map((item) => item.text)
      .join("\n\n")
      .slice(0, 500),
  };
}
