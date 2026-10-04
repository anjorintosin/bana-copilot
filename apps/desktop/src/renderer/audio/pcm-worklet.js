/**
 * Downsamples the input bus to 24 kHz mono PCM16 and emits 100ms frames.
 * Runs on the audio render thread so the UI never blocks.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 24000;
    this.frameSamples = 2400;
    this.pending = new Float32Array(0);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    const ratio = sampleRate / this.targetRate;
    const outLen = Math.max(1, Math.floor(channel.length / ratio));
    const resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const src = i * ratio;
      const i0 = Math.min(Math.floor(src), channel.length - 1);
      const i1 = Math.min(i0 + 1, channel.length - 1);
      const t = src - i0;
      resampled[i] = channel[i0] * (1 - t) + channel[i1] * t;
    }

    const merged = new Float32Array(this.pending.length + resampled.length);
    merged.set(this.pending);
    merged.set(resampled, this.pending.length);
    this.pending = merged;

    while (this.pending.length >= this.frameSamples) {
      const slice = this.pending.subarray(0, this.frameSamples);
      this.pending = this.pending.slice(this.frameSamples);
      const pcm = new Int16Array(slice.length);
      let sum = 0;
      for (let i = 0; i < slice.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        sum += sample * sample;
      }
      this.port.postMessage(
        { pcm: pcm.buffer, rms: Math.sqrt(sum / slice.length) },
        [pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
