/**
 * What the next release is, from the commits since the last tag, and writing
 * it everywhere this repository names a version.
 *
 * Three places have to agree, checked by `src/index.test.ts`: `package.json`,
 * the newest `## X.Y.Z` heading in `CHANGELOG.md`, and `RUNNER_VERSION` in
 * `src/index.ts` — the constant `--version` prints and the handshake sends.
 * crewbit-v2's `tools/release/release.ts` only ever had the first two; this
 * repository gained the third when #147 found `RUNNER_VERSION` stuck at
 * `0.0.0` since the first release, so this script writes all three or none.
 *
 * Run by `.github/workflows/release.yml` on `workflow_dispatch`, always with
 * `--apply`: nothing is committed by this script, only written to disk. The
 * workflow builds both binaries against the new files before committing,
 * tagging or pushing anything — this script deciding to write is not the
 * workflow deciding the release is good.
 *
 * `--apply` also works locally, for whoever dispatches the workflow and wants
 * to see the plan first. Without it, nothing is written and the plan prints.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Bump, bumpFor, nextVersion } from "./bump.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** The last release, or nothing, in which case the whole history counts. */
function lastTag(): string | undefined {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
  return tags[0];
}

const since = lastTag();
const range = since ? `${since}..HEAD` : "HEAD";
// `%B` is the whole message: the footer is where a breaking change explains
// itself, and a subject-only read would miss it.
const log = git("log", range, "--pretty=%B%x00");
const messages = log
  .split("\0")
  .map((one) => one.trim())
  .filter(Boolean);

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const bump = bumpFor(messages);

/** Written for a human reading the dispatch log, and for the workflow's own gate. */
function emit(fields: Record<string, string>): void {
  const lines = `${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  const target = process.env.GITHUB_OUTPUT;
  if (target) writeFileSync(target, lines, { flag: "a" });
  console.log(lines.trim());
}

if (!bump) {
  console.log(
    `nothing to release. ${messages.length} commit(s) since ${since ?? "the beginning"}, none of them a feat or a fix.`,
  );
  emit({ should_release: "false" });
  process.exit(0);
}

const version = nextVersion(manifest.version, bump);
const notes = release(messages, version, bump);

if (!values.apply) {
  console.log(`${manifest.version} -> ${version} (${bump})\n`);
  console.log(notes);
  console.log("\nNothing written. Pass --apply to write package.json, CHANGELOG.md and RUNNER_VERSION.");
  process.exit(0);
}

writeFileSync("package.json", `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

// Inserted before the first `## ` heading rather than after the first
// paragraph: this file's intro is three paragraphs (title, what this is,
// how upgrading works), not one, and splitting on the first blank line — what
// crewbit-v2's release.ts still does — moves them all below the new section.
const changelog = existsSync("CHANGELOG.md") ? readFileSync("CHANGELOG.md", "utf8") : "# crewbit\n";
const at = changelog.search(/^## /m);
const [before, after] =
  at === -1 ? [changelog.trimEnd(), ""] : [changelog.slice(0, at).trimEnd(), changelog.slice(at)];
writeFileSync("CHANGELOG.md", [before, notes, after].filter(Boolean).join("\n\n"));

const index = readFileSync("src/index.ts", "utf8");
const withVersion = index.replace(
  /export const RUNNER_VERSION = "[^"]*";/,
  `export const RUNNER_VERSION = "${version}";`,
);
if (withVersion === index) {
  console.error("src/index.ts: RUNNER_VERSION not found, nothing written there");
  process.exit(1);
}
writeFileSync("src/index.ts", withVersion);

console.log(`${manifest.version} -> ${version}`);
emit({ should_release: "true", version });

/**
 * The entry, with one line per commit that is a release.
 *
 * Only `feat:` and `fix:` appear, which is the same rule the version came from:
 * this file is read by whoever downloads the binary, and a refactor is not news
 * to them. Subjects are copied verbatim and nothing here vets them — CLAUDE.md
 * asks for English and no internal vocabulary in the commit itself, so the
 * generator does not have to tell one from the other.
 */
function release(all: string[], version: string, kind: Bump): string {
  const lines: string[] = [`## ${version}`, ""];
  const breaking = all.filter(
    (one) => /^[a-z]+(\([^)]*\))?!:/.test(one) || /^BREAKING[ -]CHANGE:/m.test(one),
  );
  const features = all.filter((one) => /^feat(\([^)]*\))?!?:/.test(one));
  const fixes = all.filter((one) => /^fix(\([^)]*\))?!?:/.test(one));

  if (breaking.length > 0 && kind === "major") {
    lines.push("### Breaking", "", ...breaking.map(subject), "");
  }
  if (features.length > 0) lines.push("### Added", "", ...features.map(subject), "");
  if (fixes.length > 0) lines.push("### Fixed", "", ...fixes.map(subject), "");

  return lines.join("\n").trimEnd();
}

/** The subject, without its type: the section already says which it is. */
function subject(message: string): string {
  const line = message.split("\n", 1)[0] ?? "";
  return `- ${line.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")}`;
}
