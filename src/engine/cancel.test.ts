/**
 * Cancelling has to stop the whole process group, not just the process the
 * runner spawned. A `claude` run spawns subprocesses for tool calls, and
 * signalling only the parent leaves them holding the workspace.
 *
 * Needs permission to list processes (`ps`), which a sandbox may deny.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { claudeCliEngine } from "./claude-cli.ts";

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
 * Stands in for the engine binary: ignores its arguments, emits one stream line,
 * backgrounds a grandchild the way a tool call would, and then waits.
 */
function engineStandIn(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crewbit-cancel-"));
  dirs.push(dir);
  markers.push(marker);
  const path = join(dir, "fake-engine.sh");
  writeFileSync(
    path,
    `#!/bin/sh
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
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

describe("aborting an engine run", () => {
  test("kills the subprocesses it spawned, not just the process itself", async () => {
    // A distinctive duration, so the count cannot pick up anything else.
    const marker = "31337";
    const engine = claudeCliEngine({ binary: engineStandIn(marker) });
    const abort = new AbortController();

    const run = engine.run({
      prompt: "go",
      cwd: tmpdir(),
      maxTurns: 1,
      signal: abort.signal,
      onEvent: () => {},
    });

    await waitFor(() => grandchildren(marker).then((n) => n > 0));
    abort.abort();
    const result = await run;

    // Measured before this existed: a plain kill(pid) leaves the grandchild
    // running, and only detached + kill(-pid) takes the group down.
    await waitFor(() => grandchildren(marker).then((n) => n === 0));
    expect(await grandchildren(marker)).toBe(0);
    expect(result.ok).toBe(false);
  });

  test("reports the interruption rather than a success it cannot substantiate", async () => {
    const engine = claudeCliEngine({ binary: engineStandIn("31338") });
    const abort = new AbortController();

    const run = engine.run({
      prompt: "go",
      cwd: tmpdir(),
      maxTurns: 1,
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
    const engine = claudeCliEngine({ binary: engineStandIn("31339") });

    const result = await engine.run({
      prompt: "go",
      cwd: tmpdir(),
      maxTurns: 1,
      signal: AbortSignal.abort(),
      onEvent: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("cancelled");
    expect(await grandchildren("31339")).toBe(0);
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
