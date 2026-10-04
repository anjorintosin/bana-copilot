import type { InterviewTrackId } from "@meeting-copilot/types";

export type ReplayCase = {
  id: string;
  track: InterviewTrackId;
  /** STT segments in order, as the Realtime API would emit them. */
  segments: string[];
  /** Pause after each segment in ms. Last pause should exceed grace (900). */
  pausesMs?: number[];
  /** Shortcut commit after the last wait. */
  commit?: boolean;
    expect: {
    question: boolean;
    specialist?: string;
    /** Multi-segment questions should not finalize before the last piece. */
    completeOnLast?: boolean;
    /** This case is a known early-fire (assembler answered a complete first half). */
    premature?: boolean;
  };
};

const lastLong = (n: number) => [...Array(n - 1).fill(400), 1200] as number[];

export const FIXTURES: ReplayCase[] = [
  {
    id: "software-coding-complete",
    track: "software",
    segments: ["Can you write a function that counts characters in a string?"],
    expect: { question: true, specialist: "coding" },
  },
  {
    id: "software-coding-two-part",
    track: "software",
    segments: [
      "Can you write a function that",
      "counts characters in a string?",
    ],
    pausesMs: lastLong(2),
    expect: { question: true, specialist: "coding", completeOnLast: true },
  },
  {
    id: "software-complexity",
    track: "software",
    segments: ["What's the time complexity of this, and how would you improve it?"],
    expect: { question: true, specialist: "coding" },
  },
  {
    id: "software-system-design",
    track: "software",
    segments: ["Design a URL shortener that can handle a hundred million clicks a day."],
    expect: { question: true, specialist: "system_design" },
  },
  {
    id: "software-behavioral",
    track: "software",
    segments: [
      "Tell me about a time you disagreed",
      "with an engineer on the approach.",
    ],
    pausesMs: lastLong(2),
    expect: { question: true, specialist: "behavioral", completeOnLast: true },
  },
  {
    id: "software-premature-trap",
    track: "software",
    segments: [
      "What is Big O of binary search?",
      "And how would you explain it to a junior?",
    ],
    pausesMs: [400, 1200],
    expect: { question: true, specialist: "coding", completeOnLast: true, premature: true },
  },
  {
    id: "data-sql",
    track: "data",
    segments: ["Write a query that joins orders to users and returns the latest order per user."],
    expect: { question: true, specialist: "coding" },
  },
  {
    id: "data-metrics",
    track: "data",
    segments: ["How would you measure whether this A/B test actually moved retention?"],
    expect: { question: true, specialist: "metrics" },
  },
  {
    id: "product-sense",
    track: "product",
    segments: ["How would you prioritize the next three features on the roadmap?"],
    expect: { question: true, specialist: "product" },
  },
  {
    id: "product-metric",
    track: "product",
    segments: ["What's the north star metric for a notes app?"],
    expect: { question: true, specialist: "metrics" },
  },
  {
    id: "design-critique",
    track: "design",
    segments: ["Walk me through how you would critique this Figma checkout flow."],
    expect: { question: true, specialist: "design" },
  },
  {
    id: "consulting-case",
    track: "consulting",
    segments: ["Our client is a grocery chain. How would you size the market for delivery?"],
    expect: { question: true, specialist: "case" },
  },
  {
    id: "finance-dcf",
    track: "finance",
    segments: ["Walk me through a DCF and how WACC shows up in it."],
    expect: { question: true, specialist: "finance" },
  },
  {
    id: "sales-objection",
    track: "sales",
    segments: ["The prospect says it's too expensive. How do you handle that objection?"],
    expect: { question: true, specialist: "sales" },
  },
  {
    id: "marketing-cac",
    track: "marketing",
    segments: ["How would you lower CAC without tanking conversion on paid search?"],
    expect: { question: true, specialist: "metrics" },
  },
  {
    id: "general-tell-me",
    track: "general",
    segments: ["Tell me about yourself."],
    expect: { question: true, specialist: "motivation" },
  },
  {
    id: "general-why-us",
    track: "general",
    segments: ["Why do you want this role, and why this company?"],
    expect: { question: true, specialist: "motivation" },
  },
  {
    id: "auto-mixed-coding",
    track: "auto",
    segments: ["Implement a function that reverses a linked list."],
    expect: { question: true, specialist: "coding" },
  },
  {
    id: "chitchat-hello",
    track: "general",
    segments: ["Hey, can you hear me?"],
    expect: { question: false },
  },
  {
    id: "candidate-speech",
    track: "software",
    segments: [
      "Yeah I'm currently a full stack engineer. I build React apps and I work with Postgres.",
    ],
    expect: { question: false },
  },
  {
    id: "unfinished-fragment",
    track: "software",
    segments: ["Can you tell me about a time when"],
    pausesMs: [1200],
    expect: { question: false },
  },
  {
    id: "noise",
    track: "general",
    segments: ["Thank you."],
    expect: { question: false },
  },
  {
    id: "software-java-plus-checkin",
    track: "software",
    segments: [
      "I asked for the difference between method overloading and method overriding in Java. Is everything all right? You can take your time.",
    ],
    expect: { question: true, specialist: "technical" },
  },
  {
    id: "checkin-only",
    track: "general",
    segments: ["Is everything all right? You can take your time."],
    expect: { question: false },
  },
  {
    id: "shortcut-commit-unfinished",
    track: "software",
    segments: ["Can you tell me about a time when"],
    pausesMs: [200],
    commit: true,
    expect: { question: true, specialist: "behavioral" },
  },
];
