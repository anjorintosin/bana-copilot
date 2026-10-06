import "./env.js";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  DEFAULT_API_PORT,
  GuardError,
  WS_PATH,
  type ClientEvent,
  type ServerEvent,
} from "@meeting-copilot/types";
import { sanitizeClientEvent, takeWriteToken } from "./guard.js";
import { migrate } from "./db.js";
import { connectRedis } from "./redis.js";
import { bearer, signUser, upsertDevice, verifyToken, type AuthUser } from "./auth.js";
import {
  assertSessionOwner,
  createSession,
  endSession,
  getSession,
  listSessions,
  saveMeetingApp,
  saveScreenEvent,
  saveSessionSummary,
  saveTranscript,
} from "./sessions.js";
import {
  getCandidateBrief,
  getProfile,
  retrieveResumeContext,
  saveProfile,
  saveResume,
  textFromPdfBase64,
} from "./resumes.js";
import { listDocuments, saveDocument } from "./documents.js";
import {
  addModeDocument,
  createMode,
  deleteMode,
  deleteModeDocument,
  listModes,
  selectMode,
  updateMode,
} from "./modes.js";
import {
  activateLocally,
  billingCompleteHtml,
  clearUserModelKey,
  completeCheckout,
  createCheckout,
  getBillingAccount,
  resolveAi,
  saveUserModelKey,
  seedBillingPlans,
} from "./billing.js";
import {
  deleteStory,
  getStoriesPayload,
  markStoryRehearsed,
  rebuildStories,
  saveStory,
} from "./stories.js";
import { getPracticePlan, runPracticeTurn } from "./practice.js";
import {
  aiStatus,
  buildSessionSummary,
  clearSessionMemory,
  commitListening,
  configureSession,
  hydrateSessionProfile,
  handleAssistRequest,
  handleScreenFrame,
  pushAudioFrame,
  resetLiveContext,
  startListening,
  stopListening,
} from "@meeting-copilot/orchestrator";

const port = Number(process.env.PORT ?? DEFAULT_API_PORT);
const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

function send(socket: { send: (data: string) => void }, event: ServerEvent) {
  socket.send(JSON.stringify(event));
}

app.get("/health", async () => ({
  ok: true,
  service: "bana-copilot-api",
  time: new Date().toISOString(),
  ai: { ...aiStatus(), keys: "user" },
}));

function writeLimited(reply: { code: (n: number) => { send: (body: unknown) => unknown } }, key: string) {
  if (takeWriteToken(key)) return false;
  reply.code(429).send({ error: "Too many saves. Wait a moment and try again." });
  return true;
}

app.post("/auth/device", async (req, reply) => {
  const body = req.body as { deviceId?: string };
  if (!body?.deviceId) {
    return reply.code(400).send({ error: "deviceId required" });
  }
  try {
    const user = await upsertDevice(body.deviceId);
    return { token: signUser(user), userId: user.userId };
  } catch (err) {
    const message = err instanceof GuardError || err instanceof Error ? err.message : "Invalid device";
    return reply.code(400).send({ error: message });
  }
});

app.get("/sessions", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return { sessions: await listSessions(user.userId) };
});

app.get("/sessions/:id", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  const detail = await getSession(id, user.userId);
  if (!detail) return reply.code(404).send({ error: "not found" });
  return detail;
});

app.get("/profile", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return getProfile(user.userId);
});

app.put("/profile", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const body = req.body as {
    jobTitle?: string;
    company?: string;
    requirements?: string;
    defaultTrack?: string;
  };
  try {
    return await saveProfile(user.userId, {
      title: body.jobTitle,
      company: body.company,
      requirements: body.requirements,
      defaultTrack: body.defaultTrack,
    });
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not save role",
    });
  }
});

app.get("/documents", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return listDocuments(user.userId);
});

app.post("/documents", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const body = req.body as {
    kind?: string;
    title?: string;
    text?: string;
    pdfBase64?: string;
  };
  try {
    return await saveDocument(user.userId, {
      kind: body.kind ?? "",
      title: body.title,
      text: body.text,
      pdfBase64: body.pdfBase64,
    });
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not save document",
    });
  }
});

app.get("/modes", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return listModes(user.userId);
});

app.post("/modes", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const body = req.body as { name?: string; instructions?: string };
  try {
    return await createMode(user.userId, body);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not create mode",
    });
  }
});

app.put("/modes/:id", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const { id } = req.params as { id: string };
  const body = req.body as { name?: string; instructions?: string };
  try {
    return await updateMode(user.userId, id, body);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not update mode",
    });
  }
});

app.delete("/modes/:id", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  try {
    return await deleteMode(user.userId, id);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not delete mode",
    });
  }
});

app.post("/modes/:id/select", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  try {
    return await selectMode(user.userId, id);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not switch mode",
    });
  }
});

app.post("/modes/:id/documents", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const { id } = req.params as { id: string };
  const body = req.body as { title?: string; text?: string; pdfBase64?: string };
  try {
    return await addModeDocument(user.userId, id, body);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not add knowledge",
    });
  }
});

app.delete("/modes/:id/documents/:docId", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const { id, docId } = req.params as { id: string; docId: string };
  try {
    return await deleteModeDocument(user.userId, id, docId);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not remove file",
    });
  }
});

app.get("/stories", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return getStoriesPayload(user.userId);
});

app.post("/stories", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const body = req.body as {
    id?: string;
    name?: string;
    tags?: string[];
    situation?: string;
    action?: string;
    result?: string;
    forbidden?: string;
    signals?: string[];
  };
  try {
    return await saveStory(user.userId, body);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not save story",
    });
  }
});

app.delete("/stories/:id", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  return deleteStory(user.userId, id);
});

app.post("/stories/rebuild", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  try {
    return await rebuildStories(user.userId);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not rebuild stories",
    });
  }
});

app.post("/stories/:id/rehearse", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  return markStoryRehearsed(user.userId, id);
});

app.get("/practice", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return getPracticePlan(user.userId);
});

app.post("/practice/turn", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, `practice:${user.userId}`)) return;
  const body = req.body as {
    question?: string;
    storyId?: string;
    prior?: { question: string; kind: string; answer: string }[];
  };
  try {
    return await runPracticeTurn(user.userId, {
      question: body.question ?? "",
      storyId: body.storyId,
      prior: body.prior,
    });
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not generate a cue card",
    });
  }
});

app.get("/account", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return getBillingAccount(user.userId);
});

app.post("/billing/checkout", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const body = req.body as { planId?: string };
  try {
    return await createCheckout(user.userId, body.planId ?? "");
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not start checkout",
    });
  }
});

app.get("/billing/complete", async (req, reply) => {
  const sessionId = (req.query as { session_id?: string }).session_id;
  if (!sessionId) {
    return reply.type("text/html").send(
      billingCompleteHtml(false, "Missing checkout session."),
    );
  }
  try {
    await completeCheckout(sessionId);
    return reply
      .type("text/html")
      .send(billingCompleteHtml(true, "Return to Home → Plan. Your plan is active."));
  } catch (err) {
    return reply.type("text/html").send(
      billingCompleteHtml(
        false,
        err instanceof Error ? err.message : "Could not confirm checkout.",
      ),
    );
  }
});

app.get("/billing/cancel", async (_req, reply) => {
  return reply
    .type("text/html")
    .send(billingCompleteHtml(false, "Checkout was cancelled. Nothing was charged."));
});

app.post("/billing/activate", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const body = req.body as { planId?: string };
  try {
    return await activateLocally(user.userId, body.planId ?? "");
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not activate plan",
    });
  }
});

app.post("/billing/key", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const body = req.body as { provider?: string; apiKey?: string; baseUrl?: string };
  try {
    return await saveUserModelKey(user.userId, body);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not save key",
    });
  }
});

app.delete("/billing/key", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  return clearUserModelKey(user.userId);
});

app.post("/resumes", async (req, reply) => {
  const user = bearer(req.headers.authorization);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (writeLimited(reply, user.userId)) return;
  const body = req.body as { text?: string; pdfBase64?: string; title?: string };
  try {
    const text = body?.pdfBase64
      ? await textFromPdfBase64(body.pdfBase64)
      : body?.text;
    if (!text) return reply.code(400).send({ error: "text or PDF required" });
    return await saveResume(user.userId, text, body.title ?? "Resume");
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : "Could not save resume",
    });
  }
});

app.get(WS_PATH, { websocket: true }, (socket, req) => {
  const token = (req.query as { token?: string }).token;
  let user: AuthUser | null = null;
  try {
    if (token) user = verifyToken(token);
  } catch {
    send(socket, {
      type: "session.error",
      code: "unauthorized",
      message: "Invalid token",
    });
    socket.close();
    return;
  }

  send(socket, {
    type: "hello",
    message: user
      ? "Bana Copilot gateway ready — start a session to persist events"
      : "Connected without auth. Call /auth/device first.",
  });

  // One listening session is active per socket at a time. Raw binary WS
  // frames (PCM16/24kHz audio) are routed to whichever session was last
  // armed with "listen.start" — they carry no JSON envelope of their own.
  let activeListenSessionId = "";
  // Assist outside a session runs on this in-memory scratchpad: nothing is saved.
  const scratchId = `scratch-${randomUUID()}`;
  const ownedSessions = new Set<string>();
  let saveQueue: Promise<unknown> = Promise.resolve();
  if (user) {
    const userId = user.userId;
    void getCandidateBrief(userId)
      .then((loaded) => hydrateSessionProfile(scratchId, loaded))
      .catch(() => undefined);
  }

  socket.on("close", () => {
    if (activeListenSessionId) stopListening(activeListenSessionId);
    clearSessionMemory(scratchId);
  });

  socket.on("message", async (raw: unknown, isBinary?: boolean) => {
    const buf = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw as Buffer[])
        : Buffer.from(raw as ArrayBuffer);
    const looksJson = isBinary === false || (isBinary !== true && buf[0] === 0x7b);
    if (!looksJson) {
      if (!activeListenSessionId) return;
      pushAudioFrame(activeListenSessionId, buf);
      return;
    }

    let event: ClientEvent;
    try {
      event = sanitizeClientEvent(JSON.parse(buf.toString("utf8")) as ClientEvent);
    } catch (err) {
      send(socket, {
        type: "session.error",
        code: err instanceof GuardError ? "bad_input" : "bad_json",
        message:
          err instanceof GuardError ? err.message : "Invalid event payload",
      });
      return;
    }

    if (event.type === "ping") {
      send(socket, { type: "pong", timestamp: Date.now() });
      return;
    }

    if (!user) {
      send(socket, {
        type: "session.error",
        code: "unauthorized",
        message: "Authenticate before sending events",
      });
      return;
    }

    try {
      if (event.type === "meeting.started") {
        const profile = await getProfile(user.userId);
        const sessionId = await createSession(user.userId, {
          title: event.jobContext?.title || profile.jobTitle,
          company: event.jobContext?.company || profile.company,
        });
        configureSession(sessionId, {
          track: event.track || profile.defaultTrack,
          stage: event.stage,
          listenMode: event.listenMode,
        });
        try {
          hydrateSessionProfile(sessionId, await getCandidateBrief(user.userId));
        } catch {
          /* answers still load the brief on the first question */
        }
        send(socket, { type: "session.ready", sessionId });
        return;
      }

      if (event.type === "meeting.ended") {
        const owns = await assertSessionOwner(event.sessionId, user.userId);
        if (!owns) {
          send(socket, {
            type: "session.error",
            code: "forbidden",
            message: "Session does not belong to this device",
          });
          return;
        }
        const endedId = event.sessionId;
        const ok = await endSession(endedId, user.userId);
        if (!ok) {
          send(socket, {
            type: "session.error",
            code: "not_found",
            message: "No active session to end",
          });
          return;
        }
        if (activeListenSessionId === endedId) activeListenSessionId = "";
        send(socket, { type: "session.ended", sessionId: endedId });
        // The recap is an LLM call; write it after the HUD has already ended the session.
        void (async () => {
          try {
            const summary = await buildSessionSummary(endedId);
            await saveSessionSummary(endedId, summary);
            await saveTranscript(endedId, "session.summary", summary).catch(() => undefined);
            send(socket, { type: "session.summary", sessionId: endedId, text: summary });
          } catch (err) {
            app.log.warn({ err, sessionId: endedId }, "session recap failed");
          } finally {
            clearSessionMemory(endedId);
          }
        })();
        return;
      }

      const givenId = "sessionId" in event ? event.sessionId : undefined;
      const scratch =
        !givenId &&
        (event.type === "assist.request" ||
          event.type === "session.config" ||
          event.type === "context.clear");
      const sessionId = givenId || (scratch ? scratchId : undefined);
      if (!sessionId) {
        send(socket, {
          type: "session.error",
          code: "no_session",
          message: "Start a session first",
        });
        return;
      }

      if (!scratch && !ownedSessions.has(sessionId)) {
        const owns = await assertSessionOwner(sessionId, user.userId);
        if (!owns) {
          send(socket, {
            type: "session.error",
            code: "forbidden",
            message: "Session does not belong to this device",
          });
          return;
        }
        ownedSessions.add(sessionId);
      }

      if (event.type === "meeting.app") {
        if (event.app) await saveMeetingApp(sessionId, event.app);
        return;
      }

      if (event.type === "session.config") {
        configureSession(sessionId, {
          track: event.track,
          stage: event.stage,
          listenMode: event.listenMode,
          modeId: event.modeId,
        });
        if (event.modeId) {
          const loaded = await getCandidateBrief(user.userId);
          hydrateSessionProfile(sessionId, loaded);
          if (sessionId !== scratchId) hydrateSessionProfile(scratchId, loaded);
        }
        return;
      }

      const forwardAi = async (aiEvent: Record<string, unknown>) => {
        if (
          (aiEvent.type === "transcript.final" ||
            aiEvent.type === "transcript.interpreted" ||
            aiEvent.type === "question.detected" ||
            aiEvent.type === "answer.completed" ||
            aiEvent.type === "summary.rolling") &&
          typeof aiEvent.text === "string" &&
          !scratch
        ) {
          const text = aiEvent.text;
          saveQueue = saveQueue
            .then(() =>
              saveTranscript(sessionId, String(aiEvent.type), text, {
                questionId: aiEvent.questionId,
                kind: aiEvent.kind,
              }),
            )
            .catch((err) => app.log.warn({ err, sessionId }, "transcript save failed"));
        }
        send(socket, aiEvent as ServerEvent);
      };
      const extras = {
        ai: undefined as
          | {
              apiKey: string;
              baseURL?: string;
              source: "hosted" | "byok" | "env";
              provider?: "openai" | "claude" | "grok";
            }
          | undefined,
        resumeContext: (question: string, opts?: { k?: number }) =>
          retrieveResumeContext(user.userId, question, opts),
        candidateBrief: () => getCandidateBrief(user.userId),
      };

      const attachAi = async () => {
        const resolved = await resolveAi(user.userId);
        if (!resolved.ok) {
          send(socket, {
            type: "session.error",
            code: resolved.code,
            message: resolved.message,
          });
          return false;
        }
        extras.ai = resolved.creds;
        return true;
      };

      if (event.type === "listen.start") {
        app.log.info({ sessionId, source: event.source }, "listen.start");
        if (!(await attachAi())) return;
        activeListenSessionId = sessionId;
        await startListening(
          sessionId,
          {
            source: event.source,
            track: event.track,
            stage: event.stage,
          },
          forwardAi,
          extras,
        );
        return;
      }

      if (event.type === "listen.commit") {
        commitListening(sessionId);
        return;
      }

      if (event.type === "listen.stop") {
        const was = stopListening(sessionId);
        if (activeListenSessionId === sessionId) activeListenSessionId = "";
        if (was) send(socket, { type: "listen.state", sessionId, active: false });
        return;
      }

      if (event.type === "assist.request") {
        if (!(await attachAi())) return;
        await handleAssistRequest(
          sessionId,
          {
            action: event.action,
            text: event.text,
            transcript: event.transcript,
            imageBase64: event.imageBase64,
            images: event.images,
            mimeType: event.mimeType,
            smart: event.smart,
          },
          forwardAi,
          extras,
        );
        return;
      }

      if (event.type === "context.clear") {
        resetLiveContext(sessionId);
        send(socket, { type: "context.cleared", sessionId });
        return;
      }

      if (event.type === "transcript.partial" || event.type === "transcript.final") {
        await saveTranscript(sessionId, event.type, event.text);
        send(socket, { type: "session.saved", sessionId, kind: event.type });
        return;
      }

      if (event.type === "screen.changed") {
        if (!(await attachAi())) return;
        await handleScreenFrame(
          sessionId,
          {
            imageBase64: event.imageBase64,
            mimeType: event.mimeType,
            imageRef: event.imageRef,
            diffRatio: event.diffRatio,
          },
          async (aiEvent) => {
            if (aiEvent.type === "screen.insight") {
              await saveScreenEvent(
                sessionId,
                event.imageRef,
                String(aiEvent.ocrText || aiEvent.text || ""),
              );
            }
            if (
              (aiEvent.type === "question.detected" ||
                aiEvent.type === "answer.completed") &&
              typeof aiEvent.text === "string"
            ) {
              await saveTranscript(sessionId, String(aiEvent.type), aiEvent.text, {
                questionId: aiEvent.questionId,
                kind: aiEvent.kind,
                source: "screen",
              });
            }
            send(socket, aiEvent as ServerEvent);
          },
          {
            resumeContext: (question, opts) =>
              retrieveResumeContext(user.userId, question, opts),
            candidateBrief: () => getCandidateBrief(user.userId),
          },
        );
        return;
      }

      app.log.info({ type: event.type, sessionId }, "client event");
      send(socket, { type: "hello", message: `ack ${event.type}` });
    } catch (err) {
      app.log.error(err);
      send(socket, {
        type: "session.error",
        code: "server",
        message: err instanceof Error ? err.message : "Server error",
      });
    }
  });
});

try {
  await migrate();
  await seedBillingPlans();
  await connectRedis();
  const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
