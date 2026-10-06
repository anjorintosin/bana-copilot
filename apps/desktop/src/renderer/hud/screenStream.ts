/**
 * Wayland screenshots from one long-lived display stream: the portal asks once, then every
 * Assist reads the latest frame instead of opening the picker again.
 */
let stream: MediaStream | null = null;
let opening: Promise<MediaStream> | null = null;

function live(current: MediaStream | null) {
  return Boolean(current?.getVideoTracks().some((track) => track.readyState === "live"));
}

async function openStream() {
  if (live(stream)) return stream as MediaStream;
  opening ??= navigator.mediaDevices
    .getDisplayMedia({ video: { frameRate: 2 }, audio: false })
    .then((next) => {
      stream = next;
      for (const track of next.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (stream === next) stream = null;
        });
      }
      return next;
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

async function readFrame(track: MediaStreamTrack) {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  }
  const scale = Math.min(1, 1280 / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  video.pause();
  video.srcObject = null;
  return canvas.toDataURL("image/jpeg", 0.62);
}

export async function grabStreamShot() {
  try {
    const current = await openStream();
    const track = current.getVideoTracks()[0];
    if (!track) return { ok: false, error: "No screen was shared." };
    const dataUrl = await readFrame(track);
    return { ok: true, dataUrl, jpegBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.name === "NotAllowedError"
        ? "Screen sharing was cancelled. Press Assist again and pick a screen."
        : "Could not capture the screen.",
    };
  }
}

export async function ensureScreenStream() {
  try {
    await openStream();
    return true;
  } catch {
    return false;
  }
}

export function stopScreenStream() {
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
}
