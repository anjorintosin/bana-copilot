/**
 * Bumped whenever a user's modes, documents, resume, stories, or role change. Live sessions
 * keep a copy of the candidate brief; they reload it when this number moves, so a mode made or
 * picked in Home is used on the very next answer instead of after an app restart.
 */
const versions = new Map<string, number>();

export function profileVersion(userId: string) {
  return versions.get(userId) ?? 0;
}

export function bumpProfileVersion(userId: string) {
  versions.set(userId, profileVersion(userId) + 1);
}

/** Routes whose successful writes change what goes into the candidate brief. */
const PROFILE_WRITES = /^\/(modes|profile|documents|resumes|stories)(\/|\?|$)/;

export function changesProfile(method: string, url: string) {
  return method !== "GET" && method !== "HEAD" && PROFILE_WRITES.test(url);
}
