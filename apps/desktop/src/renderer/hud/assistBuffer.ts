const FLOOR_MS = 20_000;
const CAP_MS = 90_000;
const GAP_MS = 2_500;
const MAX_FRAMES = 3;

export type TranscriptSeg = { at: number; text: string };
export type ScreenFrame = { at: number; jpegBase64: string };

const segs: TranscriptSeg[] = [];
const frames: ScreenFrame[] = [];

const LEAD =
  /^((so|okay|ok|alright|all right|and|now|next|great|cool|right|well|um|uh|thanks|thank you|perfect|nice|good|awesome|sure|got it|sounds good|makes sense|i see|interesting|moving on|that's great|that makes sense)[,.!\s]+)*/i;
const STEM =
  /^(what|what's|why|how|when|where|who|which|can you|could you|would you|will you|do you|did you|have you|are you|is there|is it|tell me|walk me|talk me|talk about|explain|describe|design|implement|write|build|create|give me|show me|compare|define|solve|find|estimate|sell me|suppose|imagine|i'd like you to|i want you to|i'd love to hear)\b/i;
const FOLLOW =
  /^(expand|elaborate|go deeper|go on|dig into|dig deeper|dive into|dive deeper|say more|more on|more about|keep going|continue|clarify|unpack|break (that|it|this) down|give (me )?an example|what about|how about|what if|and (why|how|what|then)|why|how so|how come)\b/i;

export function isQuestionLike(text: string) {
  const t = text.trim();
  const sentences = t.split(/(?<=[.!?])\s+/).map((sentence) => sentence.replace(LEAD, ""));
  if (sentences.some((sentence) => FOLLOW.test(sentence))) return true;
  if (t.length < 8) return false;
  if (t.includes("?")) return true;
  return sentences.some((sentence) => STEM.test(sentence));
}

export function isThinAsk(text: string) {
  const t = text.trim();
  if (!t) return true;
  if (/^(helo+|h+e+l+l+o+|hey+|hi+|yo+|sup|hiya|howdy)([!.\s]*)?$/i.test(t)) return true;
  if (/^(test|ok(ay)?|thanks?|thank you|please|hmm+|uh+|um+|yo)\.?$/i.test(t)) return true;
  if (t.length < 8 && !t.includes("?")) return true;
  return false;
}

const SCREENISH =
  /\b(screen|code|problem|function|sql|query|error|output|implement|leetcode|this here|on the screen|snippet|compile|coding|algorithm|debug|terminal|editor)\b/i;

export function screenLooksRelevant(text: string) {
  return SCREENISH.test(text);
}

const SCREEN_REQUEST =
  /\b(screen|on here|this (question|problem|code|error|task|one|exercise)|solve (this|it))\b/i;

/** Typed asks that need the screenshot sent with them. */
export function asksAboutScreen(text: string) {
  return SCREEN_REQUEST.test(text) || SCREENISH.test(text);
}

function prune(now: number) {
  const cut = now - CAP_MS;
  while (segs[0] && segs[0].at < cut) segs.shift();
  while (frames[0] && frames[0].at < cut) frames.shift();
}

export function pushTranscript(text: string, at = Date.now()) {
  const trimmed = text.trim();
  if (!trimmed) return;
  segs.push({ at, text: trimmed });
  prune(at);
}

export function pushScreenFrame(jpegBase64: string, at = Date.now()) {
  if (!jpegBase64 || jpegBase64.length < 800) return;
  frames.push({ at, jpegBase64 });
  prune(at);
}

function turnsAt(now: number) {
  prune(now);
  const groups: TranscriptSeg[][] = [];
  for (const seg of segs) {
    const last = groups[groups.length - 1];
    if (!last || seg.at - last[last.length - 1].at > GAP_MS) {
      groups.push([seg]);
    } else {
      last.push(seg);
    }
  }
  return groups;
}

export type AssistPack = {
  question: string;
  transcript: string;
  images: { imageBase64: string; mimeType: string }[];
  from: number;
  to: number;
};

const TAIL_WORDS = 14;
const groupText = (group: TranscriptSeg[]) => group.map((s) => s.text).join(" ").trim();
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

let answeredAt = 0;

/** Speech that starts after this moment is a new ask (often a follow-up), not part of the old one. */
export function markAssistAnswered(at = Date.now()) {
  answeredAt = at;
}

/**
 * Anything said since the last Assist is the ask, even a follow-up with no question words
 * ("go deeper on the caching part"). Otherwise the newest question plus short remarks.
 */
function pickQuestion(groups: TranscriptSeg[][]) {
  const fresh = answeredAt ? groups.filter((group) => group[0].at > answeredAt) : [];
  if (fresh.length) {
    const earlier = pickFrom(groups.slice(0, groups.length - fresh.length)).start;
    const start = Math.min(earlier ?? Infinity, fresh[0][0].at);
    const picked = pickFrom(fresh);
    if (picked.question) return { question: picked.question, start };
    const said = fresh.map(groupText).join(" ");
    if (!isThinAsk(said)) return { question: said, start };
  }
  return pickFrom(groups);
}

/**
 * The newest question plus short remarks after it ("keep it simple"). When more was said
 * after it than a short remark, the newest thing said is the ask.
 */
function pickFrom(groups: TranscriptSeg[][]) {
  let index = groups.length - 1;
  while (index >= 0 && !isQuestionLike(groupText(groups[index]))) index -= 1;
  if (index < 0) return { question: "", start: groups.at(-1)?.[0]?.at };
  const tail = groups.slice(index + 1);
  if (tail.length <= 2 && tail.every((group) => wordCount(groupText(group)) <= TAIL_WORDS)) {
    return {
      question: groups.slice(index).map(groupText).join(" "),
      start: groups[index][0].at,
    };
  }
  const newest = groupText(groups[groups.length - 1]);
  return {
    question: isThinAsk(newest) ? "" : newest,
    start: groups[index][0].at,
  };
}

export function sliceAssistWindow(now = Date.now()): AssistPack {
  prune(now);
  const { question, start } = pickQuestion(turnsAt(now));
  const turnStart = start ?? now - FLOOR_MS;
  const from = Math.max(now - CAP_MS, Math.min(now - FLOOR_MS, turnStart));
  const windowSegs = segs.filter((s) => s.at >= from);
  const transcript = windowSegs.map((s) => s.text).join(" ").trim();
  const windowFrames = frames.filter((f) => f.at >= from);
  const picked: ScreenFrame[] = [];
  if (windowFrames.length) {
    picked.push(windowFrames[0]);
    if (windowFrames.length > 2) {
      picked.push(windowFrames[Math.floor(windowFrames.length / 2)]);
    }
    const latest = windowFrames[windowFrames.length - 1];
    if (picked[picked.length - 1] !== latest) picked.push(latest);
  }
  return {
    question,
    transcript,
    images: picked.slice(-MAX_FRAMES).map((f) => ({
      imageBase64: f.jpegBase64,
      mimeType: "image/jpeg",
    })),
    from,
    to: now,
  };
}

export function clearAssistBuffer() {
  segs.length = 0;
  frames.length = 0;
  answeredAt = 0;
}
