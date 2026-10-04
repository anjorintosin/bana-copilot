import "./env.js";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { sanitizeDeviceId } from "@meeting-copilot/types";
import { pool } from "./db.js";

const secret = process.env.JWT_SECRET ?? "dev-only-change-me";

export type AuthUser = { userId: string; deviceId: string };

export function signUser(user: AuthUser) {
  return jwt.sign(user, secret, { expiresIn: "30d" });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, secret) as AuthUser;
}

export async function upsertDevice(rawId: string): Promise<AuthUser> {
  const deviceId = sanitizeDeviceId(rawId);
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE device_id = $1",
    [deviceId],
  );
  if (existing.rows[0]) {
    return { userId: existing.rows[0].id, deviceId };
  }
  const userId = randomUUID();
  await pool.query("INSERT INTO users (id, device_id) VALUES ($1, $2)", [
    userId,
    deviceId,
  ]);
  return { userId, deviceId };
}

export function bearer(header?: string) {
  if (!header?.startsWith("Bearer ")) return null;
  try {
    return verifyToken(header.slice(7));
  } catch {
    return null;
  }
}
