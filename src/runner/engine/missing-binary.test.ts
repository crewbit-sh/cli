/**
 * The engine's answer when there is no engine to run. A runner started on a
 * machine where the binary was never installed is the first thing anyone does
 * wrong - and with two engines to choose between it is now the second thing
 * too - so a `run()` that throws would surface as a crashed runner rather than
 * as a Job that failed for a reason somebody can read.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { claudeCliEngine } from "./claude-cli.ts";
import { copilotCliEngine } from "./copilot-cli.ts";
import type { Engine } from "./types.ts";

const ENGINES: Array<{ name: string; build: (binary: string) => Engine }> = [
  { name: "claude-cli", build: (binary) => claudeCliEngine({ binary }) },
  { name: "copilot-cli", build: (binary) => copilotCliEngine({ binary }) },
];

describe.each(ENGINES)("a $name binary that is not there", ({ build }) => {
  test("fails the run, naming the binary, rather than throwing out of run()", async () => {
    const engine = build("/nowhere/not-an-engine");

    const result = await engine.run({ prompt: "go", cwd: tmpdir(), onEvent: () => {} });

    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("spawn_failed");
    expect(result.text).toContain("/nowhere/not-an-engine");
  });

  test("still reports a version, so the handshake is sent rather than crashed", () => {
    // `"unknown"` is the answer when there is nothing to ask. A runner that
    // threw here would never dial, and the operator would learn about a missing
    // binary from a stack trace instead of from a failed Job.
    expect(build("/nowhere/not-an-engine").version).toBe("unknown");
  });
});
