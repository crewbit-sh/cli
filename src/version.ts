/**
 * Whether the runner somebody is running is behind the newest release.
 *
 * Its own file because the comparison is where this gets quietly wrong:
 * `"0.9.0" < "0.10.0"` is false as text, so a check written the obvious way
 * starts lying at the tenth minor release and nothing announces it.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `undefined` for anything that is not exactly major.minor.patch. */
function parse(version: string): [number, number, number] | undefined {
  const found = SEMVER.exec(version);
  if (!found) return undefined;
  return found.slice(1).map(Number) as [number, number, number];
}

/**
 * The line to write, or nothing to write at all.
 *
 * Nothing is the answer for the newest release, for a runner ahead of it, and
 * for a version either side could not read. That last one is deliberate: the
 * newest version arrives from the server, and a runner that cannot make sense
 * of what it was told stays quiet, because a wrong upgrade notice costs more
 * than a missing one.
 */
export function outdatedNotice(mine: string, newest: string): string | undefined {
  const here = parse(mine);
  const there = parse(newest);
  if (!here || !there) return undefined;

  for (let part = 0; part < 3; part += 1) {
    const ours = here[part] as number;
    const theirs = there[part] as number;
    if (ours !== theirs) {
      return ours < theirs
        ? `a newer runner is out: you are on ${mine}, ${newest} is the latest. https://github.com/crewbit-sh/cli/releases`
        : undefined;
    }
  }
  return undefined;
}
