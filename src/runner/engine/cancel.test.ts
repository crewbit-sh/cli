/**
 * Cancelling has to stop the whole process group, not just the process the
 * runner spawned. Either engine spawns subprocesses for tool calls, and
 * signalling only the parent leaves them holding the workspace.
 *
 * Both engines, from one table: the group kill lives in `spawn.ts` and is the
 * same code either way, which is the whole point of it being one module. A
 * second copy of this proof would only ever prove the copy.
 *
 * Needs permission to list processes (`ps`), which a sandbox may deny.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCliEngine } from "./claude-cli.ts";
import { copilotCliEngine } from "./copilot-cli.ts";
import type { Engine } from "./types.ts";

const dirs: string[] = [];
const markers: string[] = [];

afterEach(async () => {
  // A failing test would otherwise leave the stand-in's grandchild running,
  // and the next run would count it and fail for the wrong reason.
  for (const marker of markers) await reap(marker);
  markers.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function reap(marker: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `pkill -f '^sleep ${marker}$' || true`], { stdio: "ignore" });
    child.on("close", () => resolve());
  });
}

/**
 * One row per engine. `line` is a line of that engine's own stream, so the
 * stand-in is something the engine under test could have been reading when the
 * cancel arrived rather than noise it ignored.
 */
const ENGINES: Array<{
  name: string;
  build: (binary: string) => Engine;
  line: string;
  /** A distinctive duration, so the process count cannot pick up anything else. */
  marker: number;
}> = [
  {
    name: "claude-cli",
    build: (binary) => claudeCliEngine({ binary }),
    line: '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    marker: 31337,
  },
  {
    name: "copilot-cli",
    build: (binary) => copilotCliEngine({ binary, version: "test" }),
    line: '{"type":"assistant.message","data":{"content":"working","toolRequests":[]}}',
    marker: 31340,
  },
];

/**
 * Stands in for the engine binary: ignores its arguments, emits one stream line,
 * backgrounds a grandchild the way a tool call would, and then waits.
 */
function engineStandIn(marker: string, line: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crewbit-cancel-"));
  dirs.push(dir);
  markers.push(marker);
  const path = join(dir, "fake-engine.sh");
  writeFileSync(
    path,
    `#!/bin/sh
echo '${line}'
sleep ${marker} &
sleep 300
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function grandchildren(marker: string): Promise<number> {
  const child = spawn("sh", ["-c", `ps -Ao args= | grep -c '^sleep ${marker}$' || true`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  return Number(out.trim());
}

describe.each(ENGINES)("aborting a $name run", ({ build, line, marker }) => {
  test("kills the subprocesses it spawned, not just the process itself", async () => {
    const mark = String(marker);
    const engine = build(engineStandIn(mark, line));
    const abort = new AbortController();

    const run = engine.run({
      prompt: "go",
      cwd: tmpdir(),
      signal: abort.signal,
      onEvent: () => {},
    });

    await waitFor(() => grandchildren(mark).then((n) => n > 0));
    abort.abort();
    const result = await run;

    // Measured before this existed: a plain kill(pid) leaves the grandchild
    // running, and only detached + kill(-pid) takes the group down.
    await waitFor(() => grandchildren(mark).then((n) => n === 0));
    expect(await grandchildren(mark)).toBe(0);
    expect(result.ok).toBe(false);
  });

  test("reports the interruption rather than a success it cannot substantiate", async () => {
    const engine = build(engineStandIn(String(marker + 1), line));
    const abort = new AbortController();

    const run = engine.run({
      prompt: "go",
      cwd: tmpdir(),
      signal: abort.signal,
      onEvent: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    abort.abort();

    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("cancelled");
  });

  test("a signal already aborted stops before spawning anything", async () => {
    const mark = String(marker + 2);
    const engine = build(engineStandIn(mark, line));

    const result = await engine.run({
      prompt: "go",
      cwd: tmpdir(),
      signal: AbortSignal.abort(),
      onEvent: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("cancelled");
    expect(await grandchildren(mark)).toBe(0);
  });
});

/**
 * The one place in the suite that still polls, and it is not a seam anyone can
 * add: what it is waiting on is the operating system's process table, read
 * through `ps`. A process appearing or being reaped raises no event this test
 * can subscribe to.
 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
