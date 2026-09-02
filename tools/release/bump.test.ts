/**
 * What a set of commits does to a version number.
 *
 * The rule this project already writes commits to is stricter than the
 * convention: `feat:` and `fix:` are only for what the end user experiences, and
 * internal work is `docs:`, `ci:`, `test:`, `style:`, `refactor:` or `chore:`.
 * So the mapping is the whole of it — a release is what the subject lines say
 * happened, and nothing here decides that a second time.
 */

import { describe, expect, test } from "bun:test";
import { bumpFor, nextVersion } from "./bump.ts";

describe("what a subject line asks for", () => {
  test("a feature is a minor", () => {
    expect(bumpFor(["feat: the plan page shows the branch"])).toBe("minor");
  });

  test("a fix is a patch", () => {
    expect(bumpFor(["fix: a reconnect no longer leaks a connection"])).toBe("patch");
  });

  test("internal work asks for nothing", () => {
    // Every type this repository uses for work the end user never sees. If one of
    // these ever bumped a version, the binary would gain releases that are the
    // same bytes.
    expect(
      bumpFor([
        "docs: what the first Run cost to find",
        "ci: the pipeline runs what a developer runs",
        "test: the harness holds the real Dispatcher",
        "refactor: the core is a package",
        "chore: vitest is installed",
        "style: the tokens are byte-identical",
      ]),
    ).toBeNull();
  });

  test("an unrecognised subject asks for nothing rather than guessing", () => {
    expect(bumpFor(["WIP", "merge branch main", ""])).toBeNull();
  });
});

describe("a breaking change", () => {
  test("is the `!` before the colon", () => {
    expect(bumpFor(["feat!: the runner protocol drops job.status"])).toBe("major");
    expect(bumpFor(["fix(protocol)!: the frame carries a version"])).toBe("major");
  });

  test("or the footer, which is where a long explanation goes", () => {
    expect(bumpFor(["feat: a new handshake\n\nBREAKING CHANGE: the old one is refused"])).toBe(
      "major",
    );
  });

  test("but not a subject that merely says the word", () => {
    expect(bumpFor(["fix: stop breaking the changelog"])).toBe("patch");
  });
});

describe("the largest one wins", () => {
  test("a feature and a fix together are a minor", () => {
    expect(bumpFor(["fix: one", "feat: two", "chore: three"])).toBe("minor");
  });

  test("a breaking change anywhere in the set is a major", () => {
    expect(bumpFor(["fix: one", "feat!: two", "feat: three"])).toBe("major");
  });

  test("nothing at all is nothing, not a patch", () => {
    // A release nobody asked for is a tag pointing at the same bytes.
    expect(bumpFor([])).toBeNull();
  });
});

describe("applying it to a version", () => {
  test("minor and patch move the number they name", () => {
    expect(nextVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(nextVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
  });

  test("below 1.0.0 a breaking change is a minor, because nobody promised stability yet", () => {
    // Semver says anything may change in 0.x, and reaching 1.0.0 is a claim
    // somebody makes on purpose rather than one a commit makes for them.
    expect(nextVersion("0.3.1", "major")).toBe("0.4.0");
    expect(nextVersion("0.3.1", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.1", "patch")).toBe("0.3.2");
  });

  test("0.0.0 with a fix still leaves 0.0.x, which is what an unreleased thing is", () => {
    expect(nextVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(nextVersion("0.0.0", "minor")).toBe("0.1.0");
  });

  test("a version it cannot read is refused rather than guessed at", () => {
    expect(() => nextVersion("1.2", "patch")).toThrow(/1\.2/);
    expect(() => nextVersion("v1.2.3", "patch")).toThrow();
  });
});
