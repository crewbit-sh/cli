/**
 * Where a release's notes go in `CHANGELOG.md`.
 *
 * Pure, and out of `prepare.ts` for the reason `bump.ts` is: the script reads
 * git and writes files, and a test reaches this by calling it.
 *
 * The section is inserted before the first `## ` heading rather than after the
 * first paragraph — this file's intro is three paragraphs (title, what this is,
 * how upgrading works), not one, and splitting on the first blank line, what
 * the service's still does, moves them all below the new section.
 */

/** The heading a branch writes when it has news and no version number for it yet. */
const PREVIEW = "## Unreleased";

/**
 * The changelog with `notes` as its newest section.
 *
 * An `## Unreleased` preview is replaced rather than pushed down. A preview is
 * a branch saying what its release will contain before the release exists, and
 * the generated section is the same news read off the same commits: leaving
 * both lists the change twice, under a heading that now sits below the version
 * that shipped it. The commit subject wins either way, which is the contract
 * README.md already states for this changelog.
 */
export function withRelease(changelog: string, notes: string): string {
  const at = changelog.search(/^## /m);
  if (at === -1) return join(changelog.trimEnd(), notes, "");

  const before = changelog.slice(0, at).trimEnd();
  const rest = changelog.slice(at);
  return join(before, notes, rest.startsWith(PREVIEW) ? after(rest) : rest);
}

/** What follows the preview: the next section, or nothing when it was the only one. */
function after(rest: string): string {
  const next = rest.indexOf("\n## ");
  return next === -1 ? "" : rest.slice(next + 1);
}

function join(before: string, notes: string, rest: string): string {
  return [before, notes, rest].filter(Boolean).join("\n\n");
}
