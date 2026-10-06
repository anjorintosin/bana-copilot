import type { AssistAction } from "@meeting-copilot/types";

export type AssistPrompt = {
  action: AssistAction;
  kind: string;
  text: string;
  label: string;
};

const BUTTONS: Record<
  Exclude<AssistAction, "assist" | "ask" | "screen">,
  Omit<AssistPrompt, "action">
> = {
  say_next: {
    kind: "general",
    label: "What to say next",
    text: "What should I say next, right now, in two to four spoken sentences? Stay in the conversation. Do not recap the whole meeting.",
  },
  follow_up: {
    kind: "general",
    label: "Follow-up questions",
    text: "Give me 2–3 follow-up questions I should ask them next, written as the words I would actually say out loud. One breath each.",
  },
  fact_check: {
    kind: "technical",
    label: "Fact check",
    text: "Fact-check the last claim they made. If it is right, say so in one sentence. If it is wrong or shaky, say the correction in two sentences. If there is nothing to check, say that.",
  },
  recap: {
    kind: "general",
    label: "Recap",
    text: "Recap this conversation so far in 6–10 spoken sentences I can skim: what they asked, what I covered, what is still open.",
  },
};

const SCREEN_REQUEST =
  /\b(screen|on here|this (question|problem|code|error|task|one|exercise)|solve (this|it))\b/i;

/** Typed asks like "solve the question on my screen" should be answered from the screenshot. */
export function refersToScreen(text: string) {
  return SCREEN_REQUEST.test(text);
}

export function assistPrompt(
  action: AssistAction,
  typed: string | undefined,
  fallback: string,
): AssistPrompt | { error: string } {
  const typedText = typed?.trim() ?? "";

  if (action === "ask" || (action === "assist" && typedText)) {
    if (!typedText) return { error: "Type a question first, or wait for them to ask one." };
    return {
      action,
      kind: "general",
      label: "Ask AI",
      text: typedText,
    };
  }

  if (action === "assist") {
    if (!fallback.trim()) {
      return { error: "Nothing to answer yet. Wait for a question, or type one." };
    }
    return {
      action,
      kind: "general",
      label: "Assist",
      text: fallback.trim(),
    };
  }

  if (action === "screen") {
    if (!typedText) {
      return { error: "Could not read a problem on screen. Make sure the question is fully visible and try again." };
    }
    return {
      action,
      kind: "coding",
      label: "On screen",
      text: typedText,
    };
  }

  return { action, ...BUTTONS[action] };
}
