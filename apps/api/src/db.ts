import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://copilot:copilot@127.0.0.1:5432/meeting_copilot";

export const pool = new Pool({ connectionString: databaseUrl });

export async function migrate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}
