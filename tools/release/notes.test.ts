/**
 * The slice of `CHANGELOG.md` one version owns — what a GitHub Release's body
 * is built from, so a reader holding only the binary can read what changed in
 * it without the repository.
 */

import { describe, expect, test } from "bun:test";
import { sectionFor } from "./notes.ts";

const CHANGELOG = `# crewbit

What changed for the person who installs and runs this.

## 0.1.1

### Fixed

- Finished work is no longer thrown away when the connection fails at the last
  moment

## 0.1.0

First release.

### Added

- Reads an issue and writes a plan for you to approve before any code is written
`;

describe("the section one version owns", () => {
  test("starts after its own heading", () => {
    expect(sectionFor(CHANGELOG, "0.1.1")).not.toContain("## 0.1.1");
  });

  test("stops before the next heading", () => {
    expect(sectionFor(CHANGELOG, "0.1.1")).not.toContain("0.1.0");
  });

  test("carries its own content", () => {
    expect(sectionFor(CHANGELOG, "0.1.1")).toContain("Finished work is no longer thrown away");
  });

  test("the last section in the file still stops at its own end", () => {
    expect(sectionFor(CHANGELOG, "0.1.0")).toContain("Reads an issue and writes a plan");
  });

  test("a version with no heading is refused rather than returning the whole file", () => {
    expect(() => sectionFor(CHANGELOG, "9.9.9")).toThrow(/9\.9\.9/);
  });
});
