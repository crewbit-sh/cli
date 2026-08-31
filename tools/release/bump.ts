/**
 * Conventional commits to a version number, and nothing else.
 *
 * Pure on purpose: reading git and writing files is `prepare.ts`, and everything
 * that decides a release lives here where a test reaches it by calling it.
 *
 * Copied from crewbit-v2's `tools/release/bump.ts`, minus `pathsFor` and
 * `FORMER_PATHS`: those existed to scope a monorepo's git log to one package's
 * directory. This repository has no other package to scope away from — every
 * commit here is about the runner, so the whole log is read.
 */

export type Bump = "major" | "minor" | "patch";

/** The types this repository writes. Anything else is work the end user never sees. */
const RELEASES: Record<string, Bump> = { feat: "minor", fix: "patch" };

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

/**
 * What a set of commit messages asks for, or null when none of them is a release.
 *
 * `CLAUDE.md` is stricter than the convention about which type a change gets, so
 * this does not second-guess a subject line: a commit that says `chore:` is a
 * chore even if it changed behaviour, and the place to argue is the commit.
 */
export function bumpFor(messages: string[]): Bump | null {
  let highest: Bump | null = null;

  for (const message of messages) {
    const bump = ofOne(message);
    if (!bump) continue;
    if (!highest || RANK[bump] > RANK[highest]) highest = bump;
  }

  return highest;
}

function ofOne(message: string): Bump | null {
  const subject = message.split("\n", 1)[0] ?? "";
  const parsed = /^([a-z]+)(\([^)]*\))?(!)?:/.exec(subject);
  if (!parsed) return null;

  // The footer is where a breaking change gets its paragraph; `!` is the short
  // form. Either counts, and only in those two places: a subject that merely
  // contains the words is a subject about something else.
  const breaking = parsed[3] === "!" || /^BREAKING[ -]CHANGE:/m.test(message);
  if (breaking) return "major";

  return RELEASES[parsed[1] as string] ?? null;
}

/**
 * The next version, with one rule that is not arithmetic.
 *
 * Below 1.0.0 a breaking change is a minor. Semver says anything may change in
 * `0.x`, so reaching 1.0.0 is a claim about stability that somebody makes on
 * purpose — not one a commit makes on their behalf.
 */
export function nextVersion(current: string, bump: Bump): string {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!parsed) throw new Error(`cannot read "${current}" as a version: expected major.minor.patch`);

  const [major, minor, patch] = parsed.slice(1).map(Number) as [number, number, number];
  const effective = major === 0 && bump === "major" ? "minor" : bump;

  if (effective === "major") return `${major + 1}.0.0`;
  if (effective === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
