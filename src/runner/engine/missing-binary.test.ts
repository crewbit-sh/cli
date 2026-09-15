/**
 * The engine's answer when there is no engine to run. A runner started on a
 * machine where `claude` was never installed is the first thing anyone does
 * wrong, and a `run()` that throws would surface as a crashed runner rather
 * than as a Job that failed for a reason somebody can read.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { claudeCliEngine } from "./claude-cli.ts";

describe("an engine binary that is not there", () => {
  test("fails the run, naming the binary, rather than throwing out of run()", async () => {
    const engine = claudeCliEngine({ binary: "/nowhere/not-an-engine" });

    const result = await engine.run({ prompt: "go", cwd: tmpdir(), onEvent: () => {} });

    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("spawn_failed");
    expect(result.text).toContain("/nowhere/not-an-engine");
  });
});
