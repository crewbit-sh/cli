/**
 * The spawn seam, with nothing Claude-shaped in it. Every case here is a fact
 * about a child process, which is why each one runs against `/bin/sh` rather
 * than against an engine.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { type SpawnOutcome, spawnLines } from "./spawn.ts";

/** Everything a caller has to pass, with a shell script as the binary. */
function sh(script: string, extra: Partial<Parameters<typeof spawnLines>[0]> = {}) {
  return { binary: "/bin/sh", args: ["-c", script], cwd: tmpdir(), env: {}, stdin: "", ...extra };
}

/** The reader most of these use: everything the child said, one entry per line. */
const collect = async (lines: AsyncIterable<string>) => {
  const seen: string[] = [];
  for await (const line of lines) seen.push(line);
  return seen;
};

/** Narrows to the one outcome that carries a value, so a test reads as assertions. */
function exited<T>(outcome: SpawnOutcome<T>) {
  if (outcome.kind !== "exited") throw new Error(`expected an exit, got ${outcome.kind}`);
  return outcome;
}

describe("reading a child's stdout", () => {
  test("hands the caller one entry per line, and nothing about what they mean", async () => {
    const outcome = exited(await spawnLines(sh("printf 'one\\ntwo\\n'"), collect));

    expect(outcome.value).toEqual(["one", "two"]);
    expect(outcome.code).toBe(0);
    expect(outcome.cancelled).toBe(false);
  });

  test("a child that says nothing at all reads as no lines, not as a failure", async () => {
    const outcome = exited(await spawnLines(sh("exit 0"), collect));

    expect(outcome.value).toEqual([]);
    expect(outcome.code).toBe(0);
  });
});

describe("the prompt over stdin", () => {
  test("reaches the child, rather than being passed as an argument", async () => {
    const outcome = exited(await spawnLines(sh("cat", { stdin: "hello\nworld\n" }), collect));

    expect(outcome.value).toEqual(["hello", "world"]);
  });

  test("arrives whole at a size argv has no room for", async () => {
    // Why stdin exists here: a stage prompt runs to thousands of lines, and
    // ARG_MAX is around a megabyte on the platforms this runs on.
    const prompt = "x".repeat(300_000);

    const outcome = exited(await spawnLines(sh("cat", { stdin: prompt }), collect));

    expect(outcome.value).toEqual([prompt]);
  });
});

describe("a binary that is not there", () => {
  test("is reported as a spawn failure naming it, rather than thrown", async () => {
    const outcome = await spawnLines(sh("", { binary: "/nowhere/not-an-engine" }), collect);

    expect(outcome.kind).toBe("spawn_failed");
    if (outcome.kind !== "spawn_failed") throw new Error("unreachable");
    expect(outcome.error.message).toContain("/nowhere/not-an-engine");
  });
});

describe("the stderr tail", () => {
  test("keeps the last forty lines, because that is what a failure report needs", async () => {
    const outcome = exited(
      await spawnLines(
        sh("i=1; while [ $i -le 50 ]; do echo line$i >&2; i=$((i+1)); done; exit 3"),
        collect,
      ),
    );

    expect(outcome.stderr).toHaveLength(40);
    expect(outcome.stderr[0]).toBe("line11");
    expect(outcome.stderr.at(-1)).toBe("line50");
    expect(outcome.code).toBe(3);
  });

  test("drops the blank lines, so the report is forty lines of something", async () => {
    const outcome = exited(await spawnLines(sh("printf '\\n   \\nreal\\n' >&2"), collect));

    expect(outcome.stderr).toEqual(["real"]);
  });

  test("is empty for a child that wrote no stderr at all", async () => {
    expect(exited(await spawnLines(sh("exit 0"), collect)).stderr).toEqual([]);
  });
});

describe("how the child ended", () => {
  test("names the signal that killed it, rather than reporting a code it has none of", async () => {
    const outcome = exited(await spawnLines(sh("kill -TERM $$"), collect));

    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.code).toBeNull();
  });
});

describe("cancelling", () => {
  test("stops the child and says a cancel landed", async () => {
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();

    // `exec`, so the stand-in is one process rather than a shell that forks a
    // sleep: a plain `sleep` here is born in the same instant the group signal
    // lands, and a child forked just after the signal survives it and holds
    // stdout open. That is a race in the stand-in, not in the cancel.
    const running = spawnLines(
      sh("echo started; exec sleep 300", { signal: abort.signal }),
      async (lines) => {
        const seen: string[] = [];
        for await (const line of lines) {
          seen.push(line);
          started.resolve();
        }
        return seen;
      },
    );

    await started.promise;
    abort.abort();
    const outcome = exited(await running);

    expect(outcome.cancelled).toBe(true);
    // What the child said before the cancel landed is still the caller's: the
    // work was done, and discarding it would be worse than stopping late.
    expect(outcome.value).toEqual(["started"]);
  });

  test("a signal already aborted never spawns anything", async () => {
    // The binary does not exist, so a spawn would have to report itself as one
    // that failed. Reaching the cancelled outcome instead is the proof.
    const outcome = await spawnLines(
      sh("", { binary: "/nowhere/not-an-engine", signal: AbortSignal.abort() }),
      collect,
    );

    expect(outcome.kind).toBe("cancelled_before_start");
  });
});
