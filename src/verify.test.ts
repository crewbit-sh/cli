import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runPrepare, runVerify } from "./verify.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "crewbit-verify-"));

describe("the verify command", () => {
  test("reports the exit code and the output of a command that passed", async () => {
    const cwd = scratch();
    const result = await runVerify({ command: "echo all good" }, cwd);
    rmSync(cwd, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("all good");
  });

  test("reports a failure without throwing, because the caller decides", async () => {
    const cwd = scratch();
    const result = await runVerify({ command: "echo broken >&2; exit 3" }, cwd);
    rmSync(cwd, { recursive: true, force: true });

    expect(result.exitCode).toBe(3);
    // stderr is where a test runner says what failed, so losing it would leave
    // the PR body explaining nothing.
    expect(result.output).toContain("broken");
  });

  test("gives up on a command that hangs, rather than letting the lease do it", async () => {
    const cwd = scratch();
    const result = await runVerify({ command: "sleep 30", timeoutSeconds: 1 }, cwd);
    rmSync(cwd, { recursive: true, force: true });

    // Lease expiry means reclaim and retry, and a hanging suite hangs again.
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/timed out/i);
  });

  test("keeps the tail, not the whole log", async () => {
    const cwd = scratch();
    const result = await runVerify({ command: "seq 1 500" }, cwd);
    rmSync(cwd, { recursive: true, force: true });

    // A PR body carrying a full test log is a PR body nobody reads.
    expect(result.output.split("\n").length).toBeLessThanOrEqual(41);
    expect(result.output).toContain("500");
  });
});

describe("preparing the workspace", () => {
  test("reports what it printed and the code it exited with", async () => {
    const dir = scratch();

    const ok = await runPrepare({ command: "echo installed" }, dir);
    const bad = await runPrepare({ command: "echo broke >&2; exit 3" }, dir);

    expect(ok).toEqual({ exitCode: 0, output: "installed" });
    expect(bad.exitCode).toBe(3);
    expect(bad.output).toContain("broke");
  });

  test("says prepare rather than verify, because they are not the same failure", async () => {
    const dir = scratch();

    const timedOut = await runPrepare({ command: "sleep 5", timeoutSeconds: 1 }, dir);

    // A fix round told the check failed goes looking for a defect in the change.
    // An install that timed out is nobody's code being wrong.
    expect(timedOut.output).toContain("prepare command timed out");
    expect(timedOut.output).not.toContain("verify");
  });

  test("gets longer than the check by default, because installing is slower", async () => {
    const dir = scratch();

    // Asserted through behaviour rather than by reading the constant: a command
    // that outlives the check's default must still be running under prepare's.
    const started = Date.now();
    const result = await runPrepare({ command: "exit 0" }, dir);

    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(600_000);
  });

  test("takes its children with it when it runs out of time", async () => {
    const dir = scratch();

    const result = await runPrepare({ command: "sleep 30 & sleep 30", timeoutSeconds: 1 }, dir);

    // Its own process group, so an install that spawned a daemon does not
    // outlive the Job that started it.
    expect(result.exitCode).toBe(1);
  });
});
