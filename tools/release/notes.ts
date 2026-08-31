/**
 * The section of a changelog that belongs to one version.
 *
 * `release.ts` writes `## <version>` headings newest-first, so a version's
 * section runs from its own heading to the next one, or to the end of the
 * file for the oldest release. What the release workflow uses this for: a
 * GitHub Release's body, so somebody holding the binary can read what changed
 * in it without the repository.
 */
export function sectionFor(changelog: string, version: string): string {
  const heading = `## ${version}`;
  const start = changelog.indexOf(heading);
  if (start === -1) throw new Error(`no "${heading}" heading in this changelog`);

  const from = start + heading.length;
  const next = changelog.indexOf("\n## ", from);
  const body = next === -1 ? changelog.slice(from) : changelog.slice(from, next);

  return body.trim();
}
