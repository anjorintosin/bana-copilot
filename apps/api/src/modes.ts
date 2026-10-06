import { randomUUID } from "node:crypto";
import {
  GENERAL_MODE_INSTRUCTIONS,
  GENERAL_MODE_SLUG,
  LIMITS,
  sanitizeLine,
  sanitizeText,
  sanitizeUuid,
  type AnswerMode,
  type AnswerModeList,
  type ModeDocument,
} from "@meeting-copilot/types";
import { pool } from "./db.js";

const MAX_MODES = 24;
const MAX_DOCS = 12;

type ModeRow = {
  id: string;
  slug: string;
  name: string;
  instructions: string;
  builtin: boolean;
  document_count?: string | number;
};

function toMode(row: ModeRow, documents?: ModeDocument[]): AnswerMode {
  return {
    id: row.id,
    slug: row.slug ?? "",
    name: row.name,
    instructions: row.instructions ?? "",
    builtin: Boolean(row.builtin),
    documentCount: Number(row.document_count ?? documents?.length ?? 0),
    documents,
  };
}

function toDoc(row: {
  id: string;
  title: string;
  raw_text: string;
  created_at: Date | string;
}): ModeDocument {
  const text = String(row.raw_text ?? "");
  return {
    id: row.id,
    title: row.title,
    excerpt: text.replace(/\s+/g, " ").trim().slice(0, 280),
    chars: text.length,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function insertGeneral(userId: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO answer_modes (id, user_id, slug, name, instructions, builtin)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [id, userId, GENERAL_MODE_SLUG, "General", GENERAL_MODE_INSTRUCTIONS],
  );
}

export async function ensureGeneralMode(userId: string) {
  const existing = await pool.query(
    `SELECT id FROM answer_modes WHERE user_id = $1 AND slug = $2 LIMIT 1`,
    [userId, GENERAL_MODE_SLUG],
  );
  if (!existing.rows[0]) {
    try {
      await insertGeneral(userId);
    } catch {
      /* unique race */
    }
  }
  const general = await pool.query(
    `SELECT id FROM answer_modes WHERE user_id = $1 AND slug = $2 LIMIT 1`,
    [userId, GENERAL_MODE_SLUG],
  );
  const generalId = general.rows[0]?.id as string | undefined;
  if (!generalId) throw new Error("Could not create General mode.");
  await pool.query(
    `INSERT INTO user_profiles (user_id, active_mode_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET
       active_mode_id = COALESCE(user_profiles.active_mode_id, excluded.active_mode_id),
       updated_at = now()`,
    [userId, generalId],
  );
  return generalId;
}

async function modeDocs(modeId: string): Promise<ModeDocument[]> {
  const result = await pool.query(
    `SELECT id, title, raw_text, created_at
     FROM mode_documents
     WHERE mode_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [modeId, MAX_DOCS],
  );
  return result.rows.map(toDoc);
}

async function listRows(userId: string): Promise<ModeRow[]> {
  const result = await pool.query(
    `SELECT m.id, m.slug, m.name, m.instructions, m.builtin,
            (SELECT count(*)::int FROM mode_documents d WHERE d.mode_id = m.id) AS document_count
     FROM answer_modes m
     WHERE m.user_id = $1
     ORDER BY m.builtin DESC, m.created_at ASC`,
    [userId],
  );
  return result.rows as ModeRow[];
}

export async function listModes(userId: string): Promise<AnswerModeList> {
  await ensureGeneralMode(userId);
  const rows = await listRows(userId);
  const active = await pool.query(
    `SELECT active_mode_id FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  const activeModeId =
    (active.rows[0]?.active_mode_id as string | undefined) ||
    rows.find((row) => row.slug === GENERAL_MODE_SLUG)?.id ||
    rows[0]?.id ||
    "";
  const modes = await Promise.all(
    rows.map(async (row) => toMode(row, await modeDocs(row.id))),
  );
  return { modes, activeModeId };
}

async function ownedMode(userId: string, modeId: string) {
  const id = sanitizeUuid(modeId, "mode");
  const result = await pool.query(
    `SELECT id, slug, name, instructions, builtin
     FROM answer_modes
     WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  if (!result.rows[0]) throw new Error("Mode not found.");
  return result.rows[0] as ModeRow;
}

export async function getActiveMode(userId: string) {
  const listed = await listModes(userId);
  const active =
    listed.modes.find((item) => item.id === listed.activeModeId) ?? listed.modes[0];
  return active;
}

export async function createMode(
  userId: string,
  input: { name?: string; instructions?: string },
) {
  await ensureGeneralMode(userId);
  const count = await pool.query(
    `SELECT count(*)::int AS n FROM answer_modes WHERE user_id = $1`,
    [userId],
  );
  if ((count.rows[0]?.n ?? 0) >= MAX_MODES) {
    throw new Error("You already have the maximum number of modes.");
  }
  const name = sanitizeLine(input.name ?? "", LIMITS.modeName);
  const instructions = sanitizeText(input.instructions ?? "", {
    max: LIMITS.modeInstructions,
  });
  if (name.length < 2) throw new Error("Give this mode a name.");
  if (instructions.length < 8) {
    throw new Error("Say how Assist should answer in this mode.");
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO answer_modes (id, user_id, slug, name, instructions, builtin)
     VALUES ($1, $2, '', $3, $4, false)`,
    [id, userId, name, instructions],
  );
  await pool.query(
    `UPDATE user_profiles SET active_mode_id = $2, updated_at = now() WHERE user_id = $1`,
    [userId, id],
  );
  return listModes(userId);
}

export async function updateMode(
  userId: string,
  modeId: string,
  input: { name?: string; instructions?: string },
) {
  const mode = await ownedMode(userId, modeId);
  if (mode.builtin) {
    throw new Error("General is built in. You can add knowledge, but not change how it answers.");
  }
  const name = sanitizeLine(input.name ?? mode.name, LIMITS.modeName);
  const instructions = sanitizeText(input.instructions ?? mode.instructions, {
    max: LIMITS.modeInstructions,
  });
  if (name.length < 2) throw new Error("Give this mode a name.");
  if (instructions.length < 8) {
    throw new Error("Say how Assist should answer in this mode.");
  }
  await pool.query(
    `UPDATE answer_modes
     SET name = $3, instructions = $4, updated_at = now()
     WHERE user_id = $1 AND id = $2`,
    [userId, mode.id, name, instructions],
  );
  return listModes(userId);
}

export async function deleteMode(userId: string, modeId: string) {
  const mode = await ownedMode(userId, modeId);
  if (mode.builtin) throw new Error("General cannot be deleted.");
  const generalId = await ensureGeneralMode(userId);
  await pool.query(
    `UPDATE user_profiles
     SET active_mode_id = CASE WHEN active_mode_id = $2 THEN $3 ELSE active_mode_id END,
         updated_at = now()
     WHERE user_id = $1`,
    [userId, mode.id, generalId],
  );
  await pool.query(`DELETE FROM answer_modes WHERE user_id = $1 AND id = $2`, [
    userId,
    mode.id,
  ]);
  return listModes(userId);
}

export async function selectMode(userId: string, modeId: string) {
  const mode = await ownedMode(userId, modeId);
  await pool.query(
    `INSERT INTO user_profiles (user_id, active_mode_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET
       active_mode_id = excluded.active_mode_id,
       updated_at = now()`,
    [userId, mode.id],
  );
  return listModes(userId);
}

export async function addModeDocument(
  userId: string,
  modeId: string,
  input: { title?: string; text?: string; pdfBase64?: string },
) {
  const mode = await ownedMode(userId, modeId);
  const count = await pool.query(
    `SELECT count(*)::int AS n FROM mode_documents WHERE mode_id = $1`,
    [mode.id],
  );
  if ((count.rows[0]?.n ?? 0) >= MAX_DOCS) {
    throw new Error("This mode already has the maximum number of files.");
  }
  const text = input.pdfBase64
    ? await (await import("./resumes.js")).textFromPdfBase64(input.pdfBase64)
    : sanitizeText(input.text ?? "", { max: LIMITS.document });
  if (text.length < 12) {
    throw new Error("Add a bit more text, or upload a file.");
  }
  const title =
    sanitizeLine(input.title ?? "", LIMITS.title) ||
    (mode.builtin ? "General knowledge" : mode.name);
  await pool.query(
    `INSERT INTO mode_documents (id, mode_id, title, raw_text)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), mode.id, title, text],
  );
  if (mode.builtin && text.length >= 40) {
    const { saveResume } = await import("./resumes.js");
    await saveResume(userId, text, title);
  }
  return listModes(userId);
}

export async function deleteModeDocument(userId: string, modeId: string, docId: string) {
  const mode = await ownedMode(userId, modeId);
  const id = sanitizeUuid(docId, "document");
  const result = await pool.query(
    `DELETE FROM mode_documents WHERE mode_id = $1 AND id = $2`,
    [mode.id, id],
  );
  if (!result.rowCount) throw new Error("File not found.");
  return listModes(userId);
}

export async function modeKnowledgeText(userId: string, modeId?: string) {
  const listed = await listModes(userId);
  const mode =
    listed.modes.find((item) => item.id === (modeId || listed.activeModeId)) ??
    listed.modes[0];
  if (!mode) return { mode: null as AnswerMode | null, knowledge: "" };
  const docs = await pool.query(
    `SELECT title, raw_text FROM mode_documents WHERE mode_id = $1 ORDER BY created_at DESC`,
    [mode.id],
  );
  const knowledge = docs.rows
    .map((row) => `### ${row.title}\n${String(row.raw_text ?? "")}`)
    .join("\n\n")
    .slice(0, 60_000);
  return { mode, knowledge };
}
