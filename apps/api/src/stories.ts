import { randomUUID } from "node:crypto";
import { optionalUuid, sanitizeUuid, type StoriesStatus, type Story } from "@meeting-copilot/types";
import {
  extractStories,
  normalizeDraft,
  runWithAi,
  type StoryDraft,
} from "@meeting-copilot/orchestrator";
import { resolveAi } from "./billing.js";
import { pool } from "./db.js";
import { bumpProfileVersion } from "./profileVersion.js";

const extracting = new Set<string>();

function asStory(row: {
  id: string;
  name: string;
  tags: string[] | null;
  situation: string;
  action: string;
  result: string;
  forbidden: string;
  signals: string[] | null;
  rehearsed_at?: Date | string | null;
  rehearsal_count?: number | null;
}): Story {
  const rehearsed =
    row.rehearsed_at instanceof Date
      ? row.rehearsed_at.toISOString()
      : row.rehearsed_at ?? null;
  return {
    id: row.id,
    name: row.name,
    tags: row.tags ?? [],
    situation: row.situation ?? "",
    action: row.action ?? "",
    result: row.result ?? "",
    forbidden: row.forbidden ?? "",
    signals: row.signals ?? [],
    rehearsedAt: rehearsed,
    rehearsalCount: row.rehearsal_count ?? 0,
  };
}

export async function listStories(userId: string): Promise<Story[]> {
  const result = await pool.query(
    `SELECT id, name, tags, situation, action, result, forbidden, signals,
            rehearsed_at, rehearsal_count
     FROM stories
     WHERE user_id = $1
     ORDER BY ordinal ASC, updated_at ASC`,
    [userId],
  );
  return result.rows.map(asStory);
}

export async function storiesStatus(userId: string): Promise<StoriesStatus> {
  const result = await pool.query(
    `SELECT stories_status FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  const raw = (result.rows[0]?.stories_status as string) || "empty";
  if (raw === "extracting" || raw === "ready" || raw === "error") return raw;
  return "empty";
}

async function setStatus(userId: string, status: StoriesStatus) {
  // Extraction finishes in the background, after the request that started it returned.
  if (status === "ready") bumpProfileVersion(userId);
  await pool.query(
    `INSERT INTO user_profiles (user_id, stories_status, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET
       stories_status = excluded.stories_status,
       updated_at = now()`,
    [userId, status],
  );
}

async function replaceStories(
  userId: string,
  resumeId: string | null,
  drafts: StoryDraft[],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM stories WHERE user_id = $1`, [userId]);
    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i];
      await client.query(
        `INSERT INTO stories
           (id, user_id, resume_id, name, tags, situation, action, result, forbidden, signals, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(),
          userId,
          resumeId,
          draft.name,
          draft.tags,
          draft.situation,
          draft.action,
          draft.result,
          draft.forbidden,
          draft.signals,
          i,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getStoriesPayload(userId: string) {
  const [stories, status] = await Promise.all([
    listStories(userId),
    storiesStatus(userId),
  ]);
  if (!stories.length && status === "empty") {
    const resume = await pool.query(
      `SELECT r.id, r.raw_text
       FROM user_profiles p
       JOIN resumes r ON r.id = p.active_resume_id
       WHERE p.user_id = $1`,
      [userId],
    );
    const row = resume.rows[0];
    if (row?.raw_text) {
      beginStoryExtract(userId, row.id as string, row.raw_text as string);
      return { stories, status: "extracting" as const, count: 0 };
    }
  }
  return { stories, status, count: stories.length };
}

export function beginStoryExtract(
  userId: string,
  resumeId: string | null,
  resumeText: string,
  opts: { force?: boolean } = {},
) {
  if (extracting.has(userId)) return;
  void runExtract(userId, resumeId, resumeText, opts.force ?? false);
}

async function runExtract(
  userId: string,
  resumeId: string | null,
  resumeText: string,
  force: boolean,
) {
  if (extracting.has(userId)) return;
  const existing = await listStories(userId);
  if (existing.length && !force) return;
  extracting.add(userId);
  await setStatus(userId, "extracting");
  try {
    const resolved = await resolveAi(userId);
    const drafts = resolved.ok
      ? await runWithAi(resolved.creds, () => extractStories(resumeText))
      : await extractStories(resumeText);
    await replaceStories(userId, resumeId, drafts);
    await setStatus(userId, drafts.length ? "ready" : "empty");
  } catch (err) {
    console.error("[stories] extract failed", err);
    await setStatus(userId, existing.length ? "ready" : "error");
  } finally {
    extracting.delete(userId);
  }
}

export async function rebuildStories(userId: string) {
  const resume = await pool.query(
    `SELECT r.id, r.raw_text
     FROM user_profiles p
     JOIN resumes r ON r.id = p.active_resume_id
     WHERE p.user_id = $1`,
    [userId],
  );
  const row = resume.rows[0];
  if (!row?.raw_text) {
    throw new Error("Add a resume first, then rebuild stories.");
  }
  await runExtract(userId, row.id as string, row.raw_text as string, true);
  return getStoriesPayload(userId);
}

export async function saveStory(
  userId: string,
  input: Partial<Story> & { id?: string },
) {
  const draft = normalizeDraft({
    name: input.name,
    tags: input.tags,
    situation: input.situation,
    action: input.action,
    result: input.result,
    forbidden: input.forbidden,
    signals: input.signals,
  });
  if (!draft) throw new Error("Give the story a name and at least one beat.");
  const id = optionalUuid(input.id, "story");

  if (id) {
    const result = await pool.query(
      `UPDATE stories SET
         name = $3, tags = $4, situation = $5, action = $6,
         result = $7, forbidden = $8, signals = $9, updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [
        id,
        userId,
        draft.name,
        draft.tags,
        draft.situation,
        draft.action,
        draft.result,
        draft.forbidden,
        draft.signals,
      ],
    );
    if (!result.rowCount) throw new Error("Story not found.");
  } else {
    const max = await pool.query(
      `SELECT COALESCE(max(ordinal), -1)::int AS n FROM stories WHERE user_id = $1`,
      [userId],
    );
    await pool.query(
      `INSERT INTO stories
         (id, user_id, name, tags, situation, action, result, forbidden, signals, ordinal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        userId,
        draft.name,
        draft.tags,
        draft.situation,
        draft.action,
        draft.result,
        draft.forbidden,
        draft.signals,
        (max.rows[0]?.n ?? -1) + 1,
      ],
    );
  }
  await setStatus(userId, "ready");
  return getStoriesPayload(userId);
}

export async function markStoryRehearsed(userId: string, rawId: string) {
  const id = sanitizeUuid(rawId, "story");
  await pool.query(
    `UPDATE stories
     SET rehearsal_count = rehearsal_count + 1,
         rehearsed_at = now(),
         updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return getStoriesPayload(userId);
}

export async function deleteStory(userId: string, rawId: string) {
  const id = sanitizeUuid(rawId, "story");
  await pool.query(`DELETE FROM stories WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  const left = await listStories(userId);
  if (!left.length) await setStatus(userId, "empty");
  return getStoriesPayload(userId);
}
