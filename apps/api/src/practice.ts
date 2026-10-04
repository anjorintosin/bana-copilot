import {
  LIMITS,
  emptyClaims,
  formatClaims,
  optionalUuid,
  sanitizeText,
  type InterviewTrackId,
} from "@meeting-copilot/types";
import {
  buildPracticePlan,
  collectAnswer,
  formatStory,
  heuristicClaims,
  pickLockedStory,
  pickStory,
  routeQuestion,
  runWithAi,
} from "@meeting-copilot/orchestrator";
import { getCandidateBrief, getProfile } from "./resumes.js";
import { listStories, markStoryRehearsed } from "./stories.js";
import { resolveAi } from "./billing.js";

export async function getPracticePlan(userId: string) {
  const [profile, stories] = await Promise.all([
    getProfile(userId),
    listStories(userId),
  ]);
  const questions = buildPracticePlan({
    track: profile.defaultTrack,
    title: profile.jobTitle,
    company: profile.company,
    stories,
  });
  return {
    title: profile.jobTitle || "",
    company: profile.company || "",
    track: profile.defaultTrack || "auto",
    questions,
    storyCount: stories.length,
    rehearsedCount: stories.filter(
      (story) => story.rehearsedAt || (story.rehearsalCount ?? 0) > 0,
    ).length,
  };
}

export async function runPracticeTurn(
  userId: string,
  input: {
    question: string;
    storyId?: string;
    prior?: { question: string; kind: string; answer: string }[];
  },
) {
  const question = sanitizeText(input.question, { max: LIMITS.question });
  if (!question) throw new Error("Need a question to rehearse.");
  const storyId = optionalUuid(input.storyId, "story");
  const prior = (input.prior ?? []).slice(0, LIMITS.priorTurns).map((turn) => ({
    question: sanitizeText(turn.question, { max: LIMITS.question }),
    kind: sanitizeText(turn.kind, { max: 40, multiline: false }),
    answer: sanitizeText(turn.answer, { max: LIMITS.transcript }),
  }));
  const resolved = await resolveAi(userId);
  if (resolved.ok === false) throw new Error(resolved.message);

  const [profile, loaded] = await Promise.all([
    getProfile(userId),
    getCandidateBrief(userId),
  ]);
  const track = (profile.defaultTrack || "auto") as InterviewTrackId;
  const specialist = routeQuestion(question, track);
  const stories = loaded.stories;
  let picked =
    (storyId && stories.find((story) => story.id === storyId)) || null;
  const last = input.prior?.[input.prior.length - 1];
  const claims = last
    ? heuristicClaims({
        answer: last.answer,
        story: picked,
        prior: emptyClaims(),
      })
    : emptyClaims();
  if (!picked) {
    picked =
      pickLockedStory(question, stories, claims) ?? pickStory(question, stories);
  }
  if (picked && !claims.story) claims.story = picked.name;

  const result = await runWithAi(resolved.creds, () =>
    collectAnswer({
      question,
      specialist,
      track,
      brief: loaded.brief,
      ragContext: picked ? formatStory(picked) : undefined,
      prior,
      claims: formatClaims(claims),
    }),
  );

  let storiesPayload = null;
  if (picked) {
    storiesPayload = await markStoryRehearsed(userId, picked.id);
  }

  return {
    answer: result.text,
    specialist: specialist.id,
    story: picked,
    stories: storiesPayload?.stories,
    rehearsedCount: storiesPayload
      ? storiesPayload.stories.filter(
          (story) => story.rehearsedAt || (story.rehearsalCount ?? 0) > 0,
        ).length
      : undefined,
  };
}
