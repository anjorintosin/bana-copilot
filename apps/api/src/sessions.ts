import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import {
  appendLiveEvent,
  endLiveSession,
  getLiveUser,
  setLiveSession,
} from "./redis.js";

export async function createSession(
  userId: string,
  job?: { title?: string; company?: string },
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO meeting_sessions (id, user_id, job_title, company)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, job?.title ?? null, job?.company ?? null],
  );
  await setLiveSession(id, userId);
  return id;
}

export async function endSession(sessionId: string, userId: string) {
  const result = await pool.query(
    `UPDATE meeting_sessions
     SET status = 'ended', ended_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'active'
     RETURNING id`,
    [sessionId, userId],
  );
  if (!result.rowCount) return false;
  await endLiveSession(sessionId);
  return true;
}

export async function assertSessionOwner(sessionId: string, userId: string) {
  const live = await getLiveUser(sessionId);
  if (live === userId) return true;
  const row = await pool.query(
    "SELECT user_id FROM meeting_sessions WHERE id = $1",
    [sessionId],
  );
  return row.rows[0]?.user_id === userId;
}

export async function saveTranscript(
  sessionId: string,
  kind: string,
  text: string,
  payload?: unknown,
) {
  await pool.query(
    `INSERT INTO transcripts (id, session_id, kind, text, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), sessionId, kind, text, payload ? JSON.stringify(payload) : null],
  );
  await appendLiveEvent(sessionId, { kind, text, at: Date.now() });
}

export async function saveSessionSummary(sessionId: string, summary: string) {
  await pool.query(
    `UPDATE meeting_sessions SET summary = $2 WHERE id = $1`,
    [sessionId, summary],
  );
}

export async function saveMeetingApp(sessionId: string, appName: string) {
  await pool.query(
    `UPDATE meeting_sessions SET meeting_app = $2 WHERE id = $1`,
    [sessionId, appName],
  );
}

export async function saveScreenEvent(
  sessionId: string,
  imageRef: string | undefined,
  ocrText: string,
) {
  await pool.query(
    `INSERT INTO screen_events (id, session_id, image_ref, ocr_text)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), sessionId, imageRef ?? null, ocrText],
  );
  await appendLiveEvent(sessionId, {
    kind: "screen",
    imageRef,
    ocrText,
    at: Date.now(),
  });
}

export async function listSessions(userId: string) {
  const result = await pool.query(
    `SELECT id, status, job_title, company, started_at, ended_at, summary, meeting_app,
            (SELECT count(*)::int FROM transcripts t WHERE t.session_id = s.id) AS transcript_count,
            (SELECT count(*)::int FROM screen_events e WHERE e.session_id = s.id) AS screen_count
     FROM meeting_sessions s
     WHERE user_id = $1
     ORDER BY started_at DESC
     LIMIT 20`,
    [userId],
  );
  return result.rows;
}

export async function getSession(sessionId: string, userId: string) {
  const session = await pool.query(
    `SELECT id, status, job_title, company, started_at, ended_at, summary, meeting_app
     FROM meeting_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  if (!session.rows[0]) return null;
  const [transcripts, screens] = await Promise.all([
    pool.query(
      `SELECT kind, text, created_at FROM transcripts
       WHERE session_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [sessionId],
    ),
    pool.query(
      `SELECT image_ref, ocr_text, created_at FROM screen_events
       WHERE session_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [sessionId],
    ),
  ]);
  return {
    session: session.rows[0],
    transcripts: transcripts.rows,
    screens: screens.rows,
  };
}
