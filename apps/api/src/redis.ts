import "./env.js";
import { Redis } from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
});

export async function connectRedis() {
  if (redis.status === "wait") await redis.connect();
}

export async function setLiveSession(sessionId: string, userId: string) {
  await redis.hset(`meeting:${sessionId}`, {
    userId,
    status: "active",
    startedAt: Date.now().toString(),
  });
}

export async function endLiveSession(sessionId: string) {
  await redis.hset(`meeting:${sessionId}`, { status: "ended" });
  await redis.expire(`meeting:${sessionId}`, 60 * 60 * 24);
}

export async function appendLiveEvent(sessionId: string, event: unknown) {
  await redis.rpush(`meeting:${sessionId}:transcript`, JSON.stringify(event));
  await redis.ltrim(`meeting:${sessionId}:transcript`, -200, -1);
}

export async function getLiveUser(sessionId: string) {
  return redis.hget(`meeting:${sessionId}`, "userId");
}
