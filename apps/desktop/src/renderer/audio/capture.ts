export type CaptureSource = "system" | "mic";

export type CaptureHandle = {
  stop: () => void;
  setSending: (on: boolean) => void;
  getSending: () => boolean;
};

const SILENCE_RMS = 0.012;
const TRAILING_SILENCE_MS = 1500;
const FRAME_MS = 100;

async function openSystemAudio(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  for (const track of stream.getVideoTracks()) track.stop();
  const audio = stream.getAudioTracks();
  if (!audio.length || audio[0].readyState === "ended") {
    for (const track of audio) track.stop();
    throw new Error(
      "System audio was not captured. Grant System Audio Recording, or switch to My mic.",
    );
  }
  return new MediaStream(audio);
}

async function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

export async function startCapture(opts: {
  source: CaptureSource;
  onFrame: (pcm: ArrayBuffer) => void;
  onLevel: (rms: number) => void;
}): Promise<CaptureHandle> {
  const stream =
    opts.source === "system" ? await openSystemAudio() : await openMicrophone();

  const ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.audioWorklet.addModule("./pcm-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  source.connect(node);
  // Worklet must stay in the graph; keep it silent so we don't play the call back.
  node.connect(ctx.destination);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.disconnect();
  node.connect(mute);
  mute.connect(ctx.destination);

  if (ctx.state === "suspended") await ctx.resume();

  let sending = true;
  let silentMs = 0;

  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    const { pcm, rms } = event.data;
    opts.onLevel(rms);
    if (!sending) return;
    if (rms >= SILENCE_RMS) {
      silentMs = 0;
      opts.onFrame(pcm);
      return;
    }
    silentMs += FRAME_MS;
    // Keep a short tail of silence so server-side VAD can close the turn.
    if (silentMs <= TRAILING_SILENCE_MS) opts.onFrame(pcm);
  };

  return {
    getSending: () => sending,
    setSending: (on) => {
      sending = on;
      if (on) silentMs = 0;
    },
    stop: () => {
      sending = false;
      node.port.onmessage = null;
      try {
        node.disconnect();
        source.disconnect();
      } catch {
        /* already torn down */
      }
      void ctx.close();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
