import WebSocket from "ws";
import { currentAiKey } from "../llm/client.js";

/**
 * OpenAI Realtime GA transcription.
 * Beta (`OpenAI-Beta: realtime=v1` + ?intent=transcription) is shut down.
 * GA uses /v1/realtime, session.type = transcription, and we commit turns
 * ourselves — gpt-live-transcribe does not support semantic_vad.
 */

function realtimeUrl() {
  if (process.env.OPENAI_REALTIME_URL) return process.env.OPENAI_REALTIME_URL;
  // model and intent are mutually exclusive. A conversation model URL creates a
  // realtime session, which then rejects session.type = transcription.
  return "wss://api.openai.com/v1/realtime?intent=transcription";
}

const CONNECT_TIMEOUT_MS = 8_000;
const FRAME_MS = 100;
const SILENCE_RMS = 0.012;
const END_SILENCE_MS = 900;

export type RealtimeTranscriberOptions = {
  /** Domain vocabulary to bias transcription (track-specific terms). */
  vocabulary?: string;
  onPartial: (text: string) => void;
  onSegment: (text: string) => void;
  onSpeechStart: () => void;
  onSpeechStop: () => void;
  onError: (err: Error) => void;
};

function pcmRms(pcm16: Buffer) {
  const samples = Math.floor(pcm16.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples * 2; i += 2) {
    const s = pcm16.readInt16LE(i) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class RealtimeTranscriber {
  private ws: WebSocket | null = null;
  private ready = false;
  private closedByUs = false;
  private speaking = false;
  private silentMs = 0;
  private hasAudio = false;
  /** Turns committed but not transcribed yet. */
  private inFlight = 0;
  private settled: (() => void)[] = [];

  constructor(private opts: RealtimeTranscriberOptions) {}

  private releaseWaiters() {
    this.inFlight = 1;
    this.settleOne();
  }

  private settleOne() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight) return;
    const waiting = this.settled;
    this.settled = [];
    for (const done of waiting) done();
  }

  /**
   * Commit whatever was just said and wait until every committed turn has its final text,
   * so Assist answers the question that was asked a moment ago, not the one before it.
   */
  flush(timeoutMs: number): Promise<void> {
    this.commit();
    if (!this.inFlight) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A commit that never got a transcript must not slow every later Assist.
        this.inFlight = 0;
        this.settled = [];
        resolve();
      }, timeoutMs);
      this.settled.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  connect(): Promise<void> {
    const key = currentAiKey();
    if (!key) return Promise.reject(new Error("No model key for transcription"));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const socket = new WebSocket(realtimeUrl(), {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      this.ws = socket;

      const timeout = setTimeout(() => {
        finish(() => reject(new Error("Realtime transcription connect timed out")));
        socket.terminate();
      }, CONNECT_TIMEOUT_MS);

      socket.on("open", () => {
        const prompt = (this.opts.vocabulary ?? "").trim().slice(0, 900);
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "transcription",
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24000 },
                  transcription: {
                    model: process.env.OPENAI_STT_MODEL ?? "gpt-live-transcribe",
                    languages: ["en"],
                    delay: "low",
                    ...(prompt ? { prompt } : {}),
                  },
                  turn_detection: null,
                },
              },
            },
          }),
        );
      });

      socket.on("message", (raw) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.handleEvent(
          event,
          () => {
            clearTimeout(timeout);
            finish(() => resolve());
          },
          (err) => {
            clearTimeout(timeout);
            finish(() => reject(err));
          },
        );
      });

      socket.on("error", (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this.ready) {
          clearTimeout(timeout);
          finish(() => reject(error));
          return;
        }
        this.opts.onError(error);
      });

      socket.on("close", (code, reasonBuf) => {
        const reason = reasonBuf?.toString() || "no reason";
        const wasReady = this.ready;
        this.ready = false;
        console.error("[realtime-stt] close", code, reason);
        if (this.closedByUs) return;
        const error = new Error(
          `Realtime transcription connection closed (${code} ${reason})`,
        );
        if (!wasReady) {
          clearTimeout(timeout);
          finish(() => reject(error));
          return;
        }
        this.opts.onError(error);
      });
    });
  }

  private handleEvent(
    event: Record<string, unknown>,
    onReady: () => void,
    onFirstError: (err: Error) => void,
  ) {
    const type = event.type as string;
    switch (type) {
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          onReady();
        }
        break;
      case "session.created":
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof event.delta === "string" && event.delta) {
          this.opts.onPartial(event.delta);
        }
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? "").trim();
        if (text) this.opts.onSegment(text);
        this.settleOne();
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.settleOne();
        break;
      case "input_audio_buffer.speech_started":
        this.opts.onSpeechStart();
        break;
      case "input_audio_buffer.speech_stopped":
        this.opts.onSpeechStop();
        break;
      case "error": {
        const payload = event.error as
          | { message?: string; code?: string; type?: string }
          | undefined;
        const message =
          payload?.message ??
          payload?.code ??
          "Realtime transcription error";
        console.error("[realtime-stt] event", payload ?? event);
        if (/buffer too small|buffer is empty|input_audio_buffer_commit_empty/i.test(`${message} ${payload?.code ?? ""}`)) {
          // An early commit from Assist with almost no audio: nothing to transcribe, not a failure.
          this.settleOne();
          break;
        }
        const error = new Error(message);
        if (!this.ready) {
          onFirstError(error);
          break;
        }
        this.opts.onError(error);
        break;
      }
      default:
        break;
    }
  }

  /** Append one PCM16/24kHz mono audio frame (raw bytes, little-endian). */
  appendAudio(pcm16: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm16.toString("base64"),
      }),
    );
    this.hasAudio = true;

    const rms = pcmRms(pcm16);
    if (rms >= SILENCE_RMS) {
      if (!this.speaking) {
        this.speaking = true;
        this.opts.onSpeechStart();
      }
      this.silentMs = 0;
      return;
    }
    if (!this.speaking) return;
    this.silentMs += FRAME_MS;
    if (this.silentMs >= END_SILENCE_MS) this.commit();
  }

  /** End the current spoken turn so the GA API emits a final transcript. */
  commit() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.hasAudio) {
      return;
    }
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.inFlight += 1;
    this.hasAudio = false;
    if (this.speaking) this.opts.onSpeechStop();
    this.speaking = false;
    this.silentMs = 0;
  }

  close() {
    this.closedByUs = true;
    this.ready = false;
    this.releaseWaiters();
    this.hasAudio = false;
    this.speaking = false;
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
  }

  /** Drop the current socket and open a new transcription session. */
  async reconnect() {
    this.closedByUs = true;
    this.ready = false;
    this.releaseWaiters();
    this.hasAudio = false;
    this.speaking = false;
    this.silentMs = 0;
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
    this.closedByUs = false;
    await this.connect();
  }
}
