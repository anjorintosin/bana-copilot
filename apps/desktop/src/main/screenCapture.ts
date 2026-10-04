import { desktopCapturer, type NativeImage, type Rectangle } from "electron";

export type ScreenChange = {
  sourceId: string;
  name: string;
  changed: boolean;
  diffRatio: number;
  dataUrl?: string;
  jpegBase64?: string;
};

const CAPTURE_MS = 500;
const DIFF_THRESHOLD = 0.08;
const HIRES_MS = 7_000;
const BIG_CHANGE = 0.25;
const HUD_SETTLE_MS = 800;

let timer: NodeJS.Timeout | null = null;
let lastGray: Uint8Array | null = null;
let lastHiresAt = 0;
let capturing = false;
let ignoreUntil = 0;
let rebaseNext = false;
let hudBounds: Rectangle | null = null;
let captureBounds: Rectangle | null = null;

function toGray(image: NativeImage): Uint8Array {
  const { width, height } = image.getSize();
  const bmp = image.toBitmap();
  const gray = new Uint8Array(Math.ceil((width * height) / 16));
  let j = 0;
  for (let i = 0; i < bmp.length; i += 16 * 4) {
    gray[j++] = Math.round((bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3);
  }
  return gray;
}

function diffRatio(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(a[i] - b[i]) > 18) changed++;
  }
  return changed / n;
}

function overlaps(a: Rectangle, b: Rectangle) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Zero samples under the HUD so chrome flicker is not a "page change". */
function maskHud(
  gray: Uint8Array,
  width: number,
  height: number,
  display: Rectangle | null,
  hud: Rectangle | null,
) {
  if (!display || !hud || !overlaps(display, hud)) return;
  const scaleX = width / display.width;
  const scaleY = height / display.height;
  const left = Math.floor((hud.x - display.x) * scaleX) - 3;
  const top = Math.floor((hud.y - display.y) * scaleY) - 3;
  const right = Math.ceil((hud.x + hud.width - display.x) * scaleX) + 3;
  const bottom = Math.ceil((hud.y + hud.height - display.y) * scaleY) + 3;
  for (let j = 0; j < gray.length; j += 1) {
    const pixel = j * 16;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x >= left && x < right && y >= top && y < bottom) gray[j] = 0;
  }
}

export function setHudOcclusion(hud: Rectangle | null, display: Rectangle | null) {
  hudBounds = hud;
  captureBounds = display;
}

/** Drag / collapse: ignore motion, then treat the next still as the new baseline. */
export function noteHudMotion() {
  ignoreUntil = Date.now() + HUD_SETTLE_MS;
  rebaseNext = true;
}

function jpegPayload(image: NativeImage): string {
  let jpeg = image.toJPEG(58);
  if (jpeg.length > 380_000) {
    jpeg = image.resize({ width: 960, height: 540 }).toJPEG(50);
  }
  return Buffer.from(jpeg).toString("base64");
}

export async function listScreenSources() {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
}

export function startScreenWatch(
  onChange: (event: ScreenChange) => void,
): void {
  stopScreenWatch();
  timer = setInterval(async () => {
    if (capturing) return;
    capturing = true;
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 320, height: 180 },
      });
      const primary = sources[0];
      if (!primary) return;
      const { width, height } = primary.thumbnail.getSize();
      const gray = toGray(primary.thumbnail);
      maskHud(gray, width, height, captureBounds, hudBounds);
      if (Date.now() < ignoreUntil || rebaseNext) {
        lastGray = gray;
        rebaseNext = Date.now() < ignoreUntil;
        onChange({
          sourceId: primary.id,
          name: primary.name,
          changed: false,
          diffRatio: 0,
        });
        return;
      }
      const ratio = lastGray ? diffRatio(lastGray, gray) : 1;
      const changed = !lastGray || ratio >= DIFF_THRESHOLD;
      lastGray = gray;
      if (!changed) {
        onChange({
          sourceId: primary.id,
          name: primary.name,
          changed: false,
          diffRatio: ratio,
        });
        return;
      }

      const now = Date.now();
      const wantStill =
        ratio >= BIG_CHANGE || now - lastHiresAt >= HIRES_MS || lastHiresAt === 0;
      let jpegBase64: string | undefined;
      if (wantStill) {
        lastHiresAt = now;
        const hires = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1280, height: 720 },
        });
        const shot =
          hires.find((item) => item.id === primary.id) ?? hires[0] ?? primary;
        jpegBase64 = jpegPayload(shot.thumbnail);
      }

      onChange({
        sourceId: primary.id,
        name: primary.name,
        changed: true,
        diffRatio: ratio,
        dataUrl: primary.thumbnail.toDataURL(),
        jpegBase64,
      });
    } catch (err) {
      console.error("[screen] capture failed", err);
    } finally {
      capturing = false;
    }
  }, CAPTURE_MS);
}

export async function grabScreenshot() {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 720 },
  });
  const primary = sources[0];
  if (!primary) return null;
  return {
    name: primary.name,
    dataUrl: primary.thumbnail.toDataURL(),
    jpegBase64: jpegPayload(primary.thumbnail),
  };
}

export function stopScreenWatch() {
  if (timer) clearInterval(timer);
  timer = null;
  lastGray = null;
  lastHiresAt = 0;
  capturing = false;
  ignoreUntil = 0;
  rebaseNext = false;
}
