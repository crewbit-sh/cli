/**
 * The commands the runner runs itself, and never through an agent.
 *
 * Determinism is the property. An agent asked to run the tests and report is an
 * agent that can report a green it did not get, and that is exactly the fraud
 * the eval stage exists to catch.
 *
 * Two of them now, and keeping them apart is the point rather than a tidiness.
 * A prepare that fails is the environment failing and a verify that fails is the
 * change failing; a fix round told the wrong one changes the wrong thing, which
 * is what sent three rounds after code that was not broken.
 */

import { spawn } from "node:child_process";

/** A PR body carrying a full test log is a PR body nobody reads. */
const TAIL_LINES = 40;

const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Installing is slower than checking, and the same number cannot be right for
 * both: a cold dependency cache is minutes before anything has been tried.
 */
const PREPARE_TIMEOUT_SECONDS = 1800;

export type VerifyResult = { exitCode: number; output: string };

export async function runVerify(
  verify: { command: string; timeoutSeconds?: number },
  cwd: string,
): Promise<VerifyResult> {
  return run(verify.command, cwd, verify.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, "verify");
}

/**
 * What the checkout needs before anything else runs in it.
 *
 * Before the agent as well as before the check, because the code stage was
 * installing dependencies out of its own turn budget, and that ceiling is
 * already binding.
 */
export async function runPrepare(
  prepare: { command: string; timeoutSeconds?: number },
  cwd: string,
): Promise<VerifyResult> {
  return run(prepare.command, cwd, prepare.timeoutSeconds ?? PREPARE_TIMEOUT_SECONDS, "prepare");
}

function run(
  command: string,
  cwd: string,
  seconds: number,
  what: "verify" | "prepare",
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    // Through a shell, because these are what a human types: they have pipes and
    // `&&` in them, and quoting that into argv would break both.
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group, so a timeout takes the test runner's children with it.
      detached: true,
    });

    const lines: string[] = [];
    const keep = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        if (lines.length >= TAIL_LINES) lines.shift();
        lines.push(line);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Both, because a test runner says what failed on stderr.
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, seconds * 1000);
    timer.unref?.();

    const finish = (exitCode: number, note?: string) => {
      clearTimeout(timer);
      resolve({ exitCode, output: note ? `${note}\n${lines.join("\n")}` : lines.join("\n") });
    };

    child.on("error", (error) => finish(1, `could not run the ${what} command: ${error.message}`));
    child.on("close", (code) => {
      // A lease expiry would mean reclaim and retry, and a suite that hangs
      // hangs again. Failing here stops that loop before it starts.
      if (timedOut) return finish(1, `the ${what} command timed out after ${seconds}s`);
      finish(code ?? 1);
    });
  });
}
