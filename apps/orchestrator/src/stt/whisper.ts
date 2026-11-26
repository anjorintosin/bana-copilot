import { toFile } from "openai";
import { NEED_KEY, client } from "../llm/client.js";

const FRAME_MS = 100;
const SILENCE_RMS = 0.012;
const END_SILENCE_MS = 900;
const SAMPLE_RATE = 24_000;

export type WhisperTranscriberOptions = {
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

function pcm16ToWav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class WhisperTranscriber {
  private speaking = false;
  private silentMs = 0;
  private chunks: Buffer[] = [];
  private busy = false;
  private closed = false;
  private current: Promise<void> | null = null;

  constructor(private opts: WhisperTranscriberOptions) {}

  async connect() {
    if (!client()) throw new Error(NEED_KEY);
  }

  appendAudio(pcm16: Buffer) {
    if (this.closed) return;
    const rms = pcmRms(pcm16);
    if (rms >= SILENCE_RMS) {
      if (!this.speaking) {
        this.speaking = true;
        this.opts.onSpeechStart();
      }
      this.silentMs = 0;
      this.chunks.push(pcm16);
      return;
    }
    if (!this.speaking) return;
    this.silentMs += FRAME_MS;
    this.chunks.push(pcm16);
    if (this.silentMs >= END_SILENCE_MS) this.commit();
  }

  /** Transcribe what was just said and wait for it (up to timeoutMs). */
  async flush(timeoutMs: number) {
    const started = Date.now();
    if (this.busy && this.current) await Promise.race([this.current, wait(timeoutMs)]);
    this.commit();
    const left = timeoutMs - (Date.now() - started);
    if (this.current && left > 0) await Promise.race([this.current, wait(left)]);
  }

  commit() {
    if (this.closed || this.busy) return;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (this.speaking) this.opts.onSpeechStop();
    this.speaking = false;
    this.silentMs = 0;
    if (pcm.length < 2400) return;
    this.current = this.transcribe(pcm).finally(() => {
      this.current = null;
    });
  }

  close() {
    this.closed = true;
    this.chunks = [];
    this.speaking = false;
  }

  private async transcribe(pcm: Buffer) {
    const openai = client();
    if (!openai) return;
    this.busy = true;
    try {
      const wav = pcm16ToWav(pcm);
      const file = await toFile(wav, "turn.wav", { type: "audio/wav" });
      const prompt = (this.opts.vocabulary ?? "").slice(0, 220);
      const result = await openai.audio.transcriptions.create({
        file,
        model: "whisper-1",
        language: "en",
        ...(prompt ? { prompt } : {}),
      });
      const text = result.text.replace(/\s+/g, " ").trim();
      if (text.length >= 3) this.opts.onSegment(text);
    } catch (err) {
      this.opts.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.busy = false;
    }
  }
}
