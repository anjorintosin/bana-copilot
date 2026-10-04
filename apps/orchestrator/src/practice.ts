import type {
  InterviewStageId,
  InterviewTrackId,
  PracticeQuestion,
  Story,
} from "@meeting-copilot/types";

const TAG_QUESTION: Record<string, string> = {
  conflict: "Tell me about a time you disagreed with a stakeholder.",
  ownership: "Tell me about a time you owned a problem end to end.",
  failure: "Tell me about a time you failed.",
  leadership: "Tell me about a time you led without formal authority.",
  performance: "Tell me about a performance or reliability incident you handled.",
  system: "Walk me through a system you built that you are proud of.",
  collaboration: "Tell me about a time you had to work across teams.",
  initiative: "Tell me about a time you saw a gap and just went after it.",
  customer: "Tell me about a time you dealt with a difficult customer.",
  learning: "Tell me about a time you had to ramp up on something fast.",
};

const TRACK_CLOSER: Record<
  InterviewTrackId,
  { text: string; kind: string; stage: InterviewStageId }
> = {
  auto: {
    text: "How would you design a URL shortener?",
    kind: "system_design",
    stage: "system_design",
  },
  software: {
    text: "How would you design a URL shortener?",
    kind: "system_design",
    stage: "system_design",
  },
  data: {
    text: "A core metric dropped 20% week over week. How do you investigate?",
    kind: "metrics",
    stage: "case",
  },
  product: {
    text: "How would you prioritize the next three features on the roadmap?",
    kind: "product",
    stage: "case",
  },
  design: {
    text: "Walk me through how you would critique our checkout flow.",
    kind: "design",
    stage: "technical",
  },
  consulting: {
    text: "Our client is a grocery chain losing share. How would you structure the first two weeks?",
    kind: "case",
    stage: "case",
  },
  finance: {
    text: "Walk me through a DCF for a company like this.",
    kind: "finance",
    stage: "case",
  },
  sales: {
    text: "The buyer says your price is too high. What do you do?",
    kind: "sales",
    stage: "behavioral",
  },
  marketing: {
    text: "CAC just doubled. What do you look at first?",
    kind: "metrics",
    stage: "case",
  },
  general: {
    text: "What is a strength you would bring to this team?",
    kind: "motivation",
    stage: "intro",
  },
};

function questionForStory(story: Story, used: Set<string>): string {
  for (const tag of story.tags) {
    const hit = TAG_QUESTION[tag.toLowerCase()];
    if (hit && !used.has(hit)) {
      used.add(hit);
      return hit;
    }
  }
  return `Walk me through ${story.name}.`;
}

/** Local plan — no model. Intro, story drills, one track closer, wrap. */
export function buildPracticePlan(input: {
  track?: InterviewTrackId | string;
  title?: string | null;
  company?: string | null;
  stories: Story[];
}): PracticeQuestion[] {
  const track = (input.track as InterviewTrackId) || "auto";
  const role = input.title?.trim() || "this role";
  const company = input.company?.trim();
  const out: PracticeQuestion[] = [];

  out.push({
    id: "intro",
    text: "Tell me about yourself.",
    kind: "motivation",
    stage: "intro",
  });
  out.push({
    id: "why",
    text: company ? `Why ${role} at ${company}?` : `Why this ${role}?`,
    kind: "motivation",
    stage: "intro",
  });

  const used = new Set<string>();
  for (const story of input.stories.slice(0, 4)) {
    out.push({
      id: `story-${story.id}`,
      text: questionForStory(story, used),
      kind: "behavioral",
      stage: "behavioral",
      storyId: story.id,
      storyName: story.name,
      probe: "Why that choice? What would you do differently?",
    });
  }

  const closer = TRACK_CLOSER[track] ?? TRACK_CLOSER.auto;
  out.push({
    id: "closer",
    text: closer.text,
    kind: closer.kind,
    stage: closer.stage,
    probe: "What fails at 10x?",
  });
  out.push({
    id: "wrap",
    text: "Any questions for us?",
    kind: "motivation",
    stage: "wrap",
  });

  return out;
}
