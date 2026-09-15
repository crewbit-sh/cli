/**
 * Where a generated release section lands in `CHANGELOG.md`, and what happens
 * to an `## Unreleased` preview a branch wrote before the release existed.
 */

import { describe, expect, test } from "bun:test";
import { withRelease } from "./changelog.ts";

const INTRO = `# crewbit

What changed for the person who installs and runs this.

Upgrading is replacing the binary and starting it again.
`;

const RELEASED = `## 0.1.0

### Added

- Reads an issue and writes a plan for you to approve before any code is written
`;

const NOTES = `## 0.1.1

### Fixed

- the turn ceiling is gone from the runner`;

describe("writing a release into the changelog", () => {
  test("puts it above the newest release", () => {
    const written = withRelease(`${INTRO}\n${RELEASED}`, NOTES);

    expect(written.indexOf("## 0.1.1")).toBeLessThan(written.indexOf("## 0.1.0"));
  });

  test("leaves the whole intro above it, not just the first paragraph", () => {
    const written = withRelease(`${INTRO}\n${RELEASED}`, NOTES);

    expect(written.indexOf("Upgrading is replacing the binary")).toBeLessThan(
      written.indexOf("## 0.1.1"),
    );
  });

  test("leaves the releases below it as they were", () => {
    const written = withRelease(`${INTRO}\n${RELEASED}`, NOTES);

    expect(written).toContain(RELEASED.trimEnd());
  });

  test("a changelog with no release yet gets one, under its intro", () => {
    const written = withRelease(INTRO, NOTES);

    expect(written.indexOf("What changed for the person")).toBeLessThan(
      written.indexOf("## 0.1.1"),
    );
    expect(written).toContain("- the turn ceiling is gone from the runner");
  });
});

/**
 * The preview is a branch saying what its own release will contain before a
 * version number exists for it. The generated section is the same news read
 * off the same commits, so it replaces the preview rather than stacking on
 * top of it: two copies of one change under two headings is the failure this
 * covers.
 */
describe("an Unreleased preview", () => {
  const preview = `## Unreleased

### Fixed

- the turn ceiling is gone from the runner
`;

  test("is gone once the release that contains it is written", () => {
    const written = withRelease(`${INTRO}\n${preview}\n${RELEASED}`, NOTES);

    expect(written).not.toContain("## Unreleased");
  });

  test("does not leave the change listed twice", () => {
    const written = withRelease(`${INTRO}\n${preview}\n${RELEASED}`, NOTES);

    expect(written.split("- the turn ceiling is gone from the runner")).toHaveLength(2);
  });

  test("takes nothing below it with it", () => {
    const written = withRelease(`${INTRO}\n${preview}\n${RELEASED}`, NOTES);

    expect(written).toContain(RELEASED.trimEnd());
  });

  test("replaced on its own, the file is the intro and the release", () => {
    const written = withRelease(`${INTRO}\n${preview}`, NOTES);

    expect(written).toContain("## 0.1.1");
    expect(written).not.toContain("Unreleased");
  });

  test("a release heading is never mistaken for a preview", () => {
    const written = withRelease(`${INTRO}\n${RELEASED}`, NOTES);

    expect(written).toContain("- Reads an issue and writes a plan");
  });
});
