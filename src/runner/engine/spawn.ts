/**
 * Running an engine binary, with nothing in here about what an engine says.
 *
 * Every line of this was paid for by the CLI engine, and none of it is about
 * Claude: the detached process group, the prompt over stdin, the stderr tail
 * kept for the failure report, the race between the first line and a spawn that
 * never happened, and the group kill on abort. It lives beside the engines so
 * the next one brings a parser and nothing else.
 *
 * The lines go to a reader the caller passes, and this module never looks at
 * one. It reports facts - an exit code, a signal, the stderr tail, whether a
 * cancel landed - and leaves every word of a failure to the engine, whose
 * vocabulary that is.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** How much stderr to keep for the failure report. */
const STDERR_TAIL_LINES = 40;

export type SpawnOptions = {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Fed over stdin, because argv has a hard size limit and a prompt does not. */
  stdin: string;
  /** Stops the run, taking the whole process group with it. */
  signal?: AbortSignal;
};

export type SpawnOutcome<T> =
  /** The signal was already aborted, so nothing was spawned. */
  | { kind: "cancelled_before_start" }
  /** There was no process: the binary is missing, or not executable. */
  | { kind: "spawn_failed"; error: Error }
  | {
      kind: "exited";
      /** Whatever the reader made of the child's stdout. */
      value: T;
      code: number | null;
      signal: NodeJS.Signals | null;
      /** An abort landed, whether or not it is what ended the child. */
      cancelled: boolean;
      /** The last {@link STDERR_TAIL_LINES} non-blank lines, oldest first. */
      stderr: string[];
    };

/**
 * Spawns `binary`, feeds it `stdin`, and hands its stdout to `read` as lines.
 *
 * `read` is called rather than the lines being returned, because the spawn-error
 * race and the abort listener have to bracket the reading: a caller handed a
 * bare iterable would have to rebuild both, which is the duplication this
 * module exists to prevent.
 */
export async function spawnLines<T>(
  options: SpawnOptions,
  read: (lines: AsyncIterable<string>) => Promise<T>,
): Promise<SpawnOutcome<T>> {
  // An already-aborted signal fires no `abort` event, so nothing below would
  // catch it, and the child would run to completion for a Job already gone.
  if (options.signal?.aborted) return { kind: "cancelled_before_start" };

  const child = spawn(options.binary, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so cancelling can signal the whole tree. Measured:
    // a plain kill(pid) leaves a grandchild running, and an engine spawns one
    // per tool call, which would keep the workspace busy after the Job is gone.
    detached: true,
  });

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    // Negative pid means the group. Guard: the child may already be gone, and
    // an ESRCH here would surface as a failure the caller cannot act on.
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  child.stdin.end(options.stdin);

  const stderr = tailOf(child);

  const spawnFailure = new Promise<{ ok: false; error: Error }>((resolve) =>
    child.on("error", (error) => resolve({ ok: false, error })),
  );
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );

  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const finished = await Promise.race([
    read(lines).then((value) => ({ ok: true as const, value })),
    spawnFailure,
  ]);

  if (!finished.ok) {
    options.signal?.removeEventListener("abort", cancel);
    return { kind: "spawn_failed", error: finished.error };
  }

  const { code, signal } = await exit;
  // Removed rather than left: a pid is reused, and a listener outliving its
  // child would one day signal a group that belongs to somebody else.
  options.signal?.removeEventListener("abort", cancel);

  return { kind: "exited", value: finished.value, code, signal, cancelled, stderr };
}

/** The tail, filled as stderr arrives; read once the child is gone. */
function tailOf(child: ReturnType<typeof spawn>): string[] {
  const tail: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      if (tail.length >= STDERR_TAIL_LINES) tail.shift();
      tail.push(line);
    }
  });
  return tail;
}
