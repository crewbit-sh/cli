/**
 * The outcome table, which decides what a Stage reports and therefore where the
 * Run goes next.
 *
 * Every branch below used to be reachable only through a test that started a
 * server, opened a socket, cloned a repository and pushed to it, at roughly six
 * seconds each. That is the shape a real defect hid behind: `deliver` decided
 * from an exit code the comment said it did not trust, and every integration
 * test over it was green.
 */

import { describe, expect, test } from "bun:test";
import { decide } from "./outcome.ts";

const ran = { ok: true };
const stopped = { ok: false };
const ceiling = { ok: false, ceiling: true };

/** What a code Job declares: a PR body means it finished, a partial means it did not. */
const artifacts = {
  collect: ["pr-body.md", "partial.md", "blocked.md"],
  outcomes: [
    { file: "pr-body.md", outcome: "complete" as const },
    { file: "partial.md", outcome: "partial" as const },
    { file: "blocked.md", outcome: "failed" as const },
  ],
};

const wrote = (...files: string[]) => Object.fromEntries(files.map((f) => [f, "x"]));

describe("what a Stage reports", () => {
  test("the file it wrote decides, when the engine finished", () => {
    expect(decide({ result: ran, artifacts, collected: wrote("pr-body.md") }).outcome).toBe(
      "complete",
    );
    expect(decide({ result: ran, artifacts, collected: wrote("partial.md") }).outcome).toBe(
      "partial",
    );
    expect(decide({ result: ran, artifacts, collected: wrote("blocked.md") }).outcome).toBe(
      "failed",
    );
  });

  test("the first declared file wins, so two of them is not ambiguous", () => {
    expect(
      decide({ result: ran, artifacts, collected: wrote("partial.md", "pr-body.md") }).outcome,
    ).toBe("complete");
  });

  test("writing none of them is a failure, never a silent success", () => {
    expect(decide({ result: ran, artifacts, collected: {} }).outcome).toBe("failed");
  });

  test("a Job that declared no artifacts is complete on the engine finishing", () => {
    expect(decide({ result: ran, artifacts: undefined, collected: {} }).outcome).toBe("complete");
  });

  test("an engine that stopped without finishing is failed, whatever it wrote", () => {
    expect(decide({ result: stopped, artifacts, collected: wrote("pr-body.md") }).outcome).toBe(
      "failed",
    );
  });
});

describe("a Stage that stopped at its turn ceiling", () => {
  // Incomplete-by-budget is a different condition from a broken change, and the
  // fix loop can solve one and not the other. It was unreachable once: the
  // runner mapped `result.ok ? decideOutcome(…) : "failed"`, so a ceiling run
  // never consulted the table at all and #8 reported `failed` with six real
  // commits on its branch.
  test("is partial whichever file it wrote, including none", () => {
    for (const collected of [{}, wrote("partial.md"), wrote("pr-body.md")]) {
      expect(decide({ result: ceiling, artifacts, collected }).outcome).toBe("partial");
    }
  });

  test("stays partial whatever the check said, because the check is about a finished change", () => {
    expect(
      decide({ result: ceiling, artifacts, collected: {}, checked: { exitCode: 1 } }).outcome,
    ).toBe("partial");
  });
});

describe("work that did not reach the remote", () => {
  // It outranks everything: reporting anything else is what makes the fix loop
  // chase a criterion the code already satisfies.
  test("outranks the artifact the agent wrote", () => {
    expect(
      decide({ problem: "failed", result: ran, artifacts, collected: wrote("pr-body.md") }).outcome,
    ).toBe("failed");
  });

  test("outranks the ceiling, so a partial with nothing delivered is failed", () => {
    expect(decide({ problem: "failed", result: ceiling, artifacts, collected: {} }).outcome).toBe(
      "failed",
    );
  });
});

describe("the project's own check", () => {
  test("turns a would-be complete into failed, and says it flipped", () => {
    const decided = decide({
      result: ran,
      artifacts,
      collected: wrote("pr-body.md"),
      checked: { exitCode: 1 },
    });

    expect(decided).toEqual({ outcome: "failed", flipped: true });
  });

  test("a green check changes nothing", () => {
    expect(
      decide({ result: ran, artifacts, collected: wrote("pr-body.md"), checked: { exitCode: 0 } }),
    ).toEqual({ outcome: "complete", flipped: false });
  });

  test("upgrades nothing, so a red check on an already-failed Stage is not a flip", () => {
    // Only `complete` flips, which is what keeps the note it writes from
    // overwriting a `blocked.md` the agent wrote: that one is already failed.
    expect(
      decide({ result: ran, artifacts, collected: wrote("blocked.md"), checked: { exitCode: 1 } }),
    ).toEqual({ outcome: "failed", flipped: false });
  });

  test("does not rescue work that never landed", () => {
    expect(
      decide({
        problem: "failed",
        result: ran,
        artifacts,
        collected: wrote("pr-body.md"),
        checked: { exitCode: 0 },
      }),
    ).toEqual({ outcome: "failed", flipped: false });
  });

  test("no check at all leaves the decision where it was", () => {
    expect(decide({ result: ran, artifacts, collected: wrote("pr-body.md") })).toEqual({
      outcome: "complete",
      flipped: false,
    });
  });
});
