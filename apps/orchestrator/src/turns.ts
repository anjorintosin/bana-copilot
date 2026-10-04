import { isClearlyCompleteQuestion, isQuestionLike, seemsUnfinished } from "./questions.js";

export type Scheduler = {
  schedule: (fn: () => void, ms: number) => () => void;
};

export type TurnAssemblerOptions = {
  /** Fired on every finished STT segment, so the HUD can show "they're still talking…". */
  onPending: (text: string) => void;
  /** Fired once a turn is judged finished. `force` skips "is this a question?" gating. */
  onFinalTurn: (text: string, force?: boolean) => void;
  /** Wait this long after a clearly-finished question before answering. */
  quickGraceMs?: number;
  /** Wait this long after a question-shaped-but-maybe-unfinished turn. */
  graceMs?: number;
  /** Injected clock for replay. Defaults to setTimeout. */
  scheduler?: Scheduler;
};

const DEFAULT_QUICK_GRACE_MS = 300;
const DEFAULT_GRACE_MS = 900;

/**
 * Joins streaming transcription segments into interviewer "turns" and decides
 * when they're actually done, instead of answering the instant any text
 * shows up. Backed by OpenAI's semantic VAD (segment boundaries) plus local
 * heuristics (is this question-shaped? does it trail off?).
 */
const defaultScheduler: Scheduler = {
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export class TurnAssembler {
  private buffer = "";
  private cancelTimer: (() => void) | null = null;
  private readonly quickGraceMs: number;
  private readonly graceMs: number;
  private readonly scheduler: Scheduler;

  constructor(private opts: TurnAssemblerOptions) {
    this.quickGraceMs = opts.quickGraceMs ?? DEFAULT_QUICK_GRACE_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.scheduler = opts.scheduler ?? defaultScheduler;
  }

  /** New speech. If we already have a finished question, answer it now —
   *  the next audio is usually the candidate talking, not more question. */
  handleSpeechStart() {
    if (isClearlyCompleteQuestion(this.buffer)) {
      this.clearTimer();
      this.finalize(false);
      return;
    }
    this.clearTimer();
  }

  /** VAD says they paused. We still wait for the segment's actual text. */
  handleSpeechStop() {
    /* no-op: finalize is driven by handleSegment, not raw VAD stop */
  }

  /** A finished transcription segment arrived from the Realtime API. */
  handleSegment(text: string) {
    const clean = text.trim();
    if (!clean) return;

    this.buffer = this.buffer ? `${this.buffer} ${clean}` : clean;
    this.opts.onPending(this.buffer);
    this.clearTimer();

    if (!isQuestionLike(this.buffer)) return;

    const clear = isClearlyCompleteQuestion(this.buffer);
    if (!clear && seemsUnfinished(this.buffer)) {
      // Looks like a question but trails off ("...and how would you—").
      // Don't start a timer yet; wait for more speech or a forced commit.
      return;
    }

    const delay = clear ? this.quickGraceMs : this.graceMs;
    this.cancelTimer = this.scheduler.schedule(() => {
      this.cancelTimer = null;
      this.finalize(false);
    }, delay);
  }

  /** Force whatever has accumulated to finalize now (shortcut "commit" press). */
  commitNow() {
    this.clearTimer();
    this.finalize(true);
  }

  reset() {
    this.clearTimer();
    this.buffer = "";
  }

  private clearTimer() {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private finalize(force: boolean) {
    const text = this.buffer.trim();
    this.buffer = "";
    if (text) this.opts.onFinalTurn(text, force);
  }
}
