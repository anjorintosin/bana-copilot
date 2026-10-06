const STEM =
  /\b(what|why|how|when|where|who|which|tell me|walk me|explain|can you|could you|would you|describe|have you|do you|did you|are you|is there|what's|how would|how do|how does|give me|talk (me )?(about|through)|share|difference between)\b/i;

const COMMAND =
  /\b(implement|write (me )?(a |an )?(sql )?query|write a (function|program)|solve this|code this|design (a|an)|estimate|sell me|pitch (me|us)|walk (me|us) through|tell (me|us) about|explain|compare|prioriti[sz]e|size the market|how many|overload|override|overloading|overriding)\b/i;

const INTERVIEWER_OPEN =
  /^(so,?\s*)?(okay,?\s*)?(alright,?\s*)?(now,?\s*)?(and,?\s*)?(what|why|how|when|where|who|which|tell me|walk me|explain|can you|could you|would you|describe|have you|do you|did you|are you|is there|let's|lets|please|imagine|suppose|say you)\b/i;

const FIRST_PERSON_OPEN =
  /^(so,?\s*)?(basically,?\s*)?(yeah,?\s*)?(yes,?\s*)?(sure,?\s*)?(right,?\s*)?(okay,?\s*)?(i'm|i am|i've|i have|i build|i develop|i work|i manage|i would|i'd|i use|i used|i created|i designed|i implemented|i led|i think|my name|as a |currently i|for me,|in my)\b/i;

const FIRST_PERSON =
  /\b(i'm|i am|i've|i have|i build|i develop|i work|i manage|i would|i'd|i use|i used|i led)\b/gi;

const CANDIDATE_NARRATE =
  /\b(how i (would|'d|will|usually)|what i (would|'d|did|usually)|i would (probably|start|say|do|go)|in my (case|experience))\b/i;

const CHITCHAT =
  /\b(can you hear me|how are you|what's up|good morning|good afternoon|good evening|nice to meet you|thanks|thank you|okay cool|alright|sounds good|you're on mute)\b/i;

const GREETING =
  /^(helo+|h+e+l+l+o+|hey+|hi+|yo+|sup|hiya|howdy)([!.\s]*)?$/i;

/** Soft check-ins that end with ? but are not interview questions. */
const CHECK_IN =
  /\b(is everything (all )?(right|ok|okay|good)|are you (all )?(good|ok|okay|ready|there|with me)|you (all )?(good|ok|okay)|all (good|set|right)|take your time|no rush|whenever you('re| are) ready|you can take your time|am i audible|can you see (me|my|the|this)|what if that helps)\b/i;

/** Words a sentence rarely ends on when the speaker has finished. */
const TRAILING =
  /\b(and|or|but|so|because|like|the|a|an|to|of|with|about|for|if|when|that|which|where|um|uh|er|is|are|was|your|my|our|this|in|on|at|from|into|then|also)[,.]?$/i;

/** Things Whisper invents on silence, music, or keyboard noise. */
const STT_NOISE =
  /^(thank you\.?|thanks( for watching)?[.!]?|you\.?|bye\.?|okay\.?|ok\.?|so\.?|um\.?|uh\.?|hmm\.?|mm-?hmm\.?|\.+|subtitles? by .*|please subscribe.*|amara\.org.*)$/i;

export function isNoiseTranscript(text: string) {
  const t = text.trim();
  return t.length < 3 || STT_NOISE.test(t);
}

export function isCheckIn(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (isThinAsk(t)) return true;
  if (CHECK_IN.test(t) && !hasInterviewSubstance(t)) return true;
  if (CHITCHAT.test(t) && !hasInterviewSubstance(t)) return true;
  return false;
}

/** Typed junk that is not an interview question (hello, helo, hi, ok). */
export function isThinAsk(text: string) {
  const t = text.trim();
  if (!t) return true;
  if (GREETING.test(t)) return true;
  if (/^(test|ok(ay)?|thanks?|thank you|please|hmm+|uh+|um+|yo)\.?$/i.test(t)) return true;
  if (t.length < 8 && !t.includes("?")) return true;
  return false;
}

export function hasInterviewSubstance(text: string) {
  return COMMAND.test(text) || /\bdifference between\b/i.test(text) || (STEM.test(text) && text.length > 48);
}

export function isQuestionLike(text: string) {
  const t = text.trim();
  if (t.length < 8) return false;
  if (isCheckIn(t)) return false;
  return t.includes("?") || STEM.test(t) || COMMAND.test(t);
}

/** True when the speaker most likely stopped mid-thought. */
export function seemsUnfinished(text: string) {
  const t = text.trim();
  if (!t) return true;
  if (/\?\s*$/.test(t)) return false;
  if (/(,|\.\.\.|…|-)\s*$/.test(t)) return true;
  return TRAILING.test(t);
}

/** A finished question we can answer without asking the model first. */
export function isClearlyCompleteQuestion(text: string) {
  const t = text.trim();
  return t.length >= 14 && /\?\s*$/.test(t) && isQuestionLike(t) && !seemsUnfinished(t);
}

export function looksLikeInterviewer(text: string) {
  const t = text.trim();
  if (t.includes("?")) return true;
  if (INTERVIEWER_OPEN.test(t)) return true;
  return /\b(tell me about|walk me through|can you (explain|walk|tell)|how would you|what is|what's the)\b/i.test(
    t,
  );
}

/** Only meaningful on microphone audio, where both voices are mixed together. */
export function isCandidateSpeech(text: string) {
  const t = text.trim();
  if (FIRST_PERSON_OPEN.test(t)) return true;
  if (CANDIDATE_NARRATE.test(t) && !/\?\s*$/.test(t)) return true;
  const hits = t.match(FIRST_PERSON)?.length ?? 0;
  if (hits >= 2) return true;
  if (hits >= 1 && t.length > 36 && !/\?\s*$/.test(t)) return true;
  return false;
}

/** A follow-up that should replace the card while the candidate is still talking. */
export function isLikelyNewQuestion(text: string) {
  const t = extractLatestQuestion(text);
  if (isCandidateSpeech(t)) return false;
  if (isCheckIn(t)) return false;
  if (/\?\s*$/.test(t)) return true;
  if (looksLikeInterviewer(t)) return true;
  if (isQuestionLike(t) && !seemsUnfinished(t)) return true;
  if (COMMAND.test(t) && !FIRST_PERSON_OPEN.test(t)) return true;
  return false;
}

function questionWeight(text: string) {
  const t = text.trim();
  if (!t || isCheckIn(t) || isNoiseTranscript(t)) return 0;
  let score = 0;
  if (COMMAND.test(t)) score += 5;
  if (/\bdifference between\b/i.test(t)) score += 5;
  if (STEM.test(t)) score += 2;
  if (/\?/.test(t) && !CHECK_IN.test(t)) score += 1;
  if (t.length > 40) score += 1;
  return score;
}

/** Prefer the real interview question, not a trailing check-in. */
export function extractLatestQuestion(text: string) {
  const chunks = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chunks.length) return text.trim();
  if (chunks.length === 1) return chunks[0];
  let best = "";
  let bestScore = 0;
  for (const chunk of chunks) {
    const score = questionWeight(chunk);
    if (score > bestScore) {
      bestScore = score;
      best = chunk;
    }
  }
  return best || chunks.find((chunk) => !isCheckIn(chunk)) || text.trim();
}

export function overlapsAnswer(speech: string, answer: string) {
  const a = normalizeQuestion(speech);
  const b = normalizeQuestion(answer).slice(0, 600);
  if (a.length < 18 || b.length < 18) return false;
  const words = a.split(" ").filter((w) => w.length > 3);
  if (words.length < 4) return false;
  const hits = words.filter((w) => b.includes(w)).length;
  return hits / words.length >= 0.4;
}

export function normalizeQuestion(text: string) {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function sameQuestion(a: string, b: string) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
