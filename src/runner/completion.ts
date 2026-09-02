/**
 * Handing the outcome over, until somebody takes it.
 *
 * Measured twice on one Job: three commits written and pushed, the project's
 * own suite green, and then `job.complete` failed once against a server that
 * would not answer. The runner logged a warning, deleted the workspace and
 * freed its slot, so everything the Job had done was gone and it ran again
 * from scratch.
 *
 * One attempt was the whole of it. Every other message the runner sends is
 * either idempotent or repeated, and this one was neither, which made a single
 * network fault unsurvivable. Repeating it is safe by construction rather than
 * by luck: the server refuses a second outcome for a Job that already has one.
 */

import { errorFields, type Logger } from "../log.ts";
import { waited } from "./wait.ts";

/** First wait between attempts. Doubles from here. */
const RETRY_MS = 1_000;
/**
 * The longest single wait, so patience is spent on attempts rather than inside
 * one of them. It is also the reconnect's own ceiling: waiting longer than the
 * socket takes to come back is waiting for nothing.
 */
export const MAX_RETRY_MS = 30_000;
/**
 * How long the runner keeps offering an outcome nobody has taken.
 *
 * The same window and the same reasoning as `REFUSAL_PATIENCE_MS`: a Job in hand
 * is worth two minutes of waiting, and dialling forever is not. A count of
 * attempts would have been the wrong shape, because the failure this has to
 * outlast is a dropped socket, and three attempts can pass before the reconnect
 * has finished backing off.
 *
 * Running out costs one Job re-run from scratch, which is what every failure
 * cost before this existed.
 */
const PATIENCE_MS = 180_000;

export type Delivery = {
  jobId: string;
  /** Rejects when the server refused the outcome, or the socket carrying it is gone. */
  send: () => Promise<unknown>;
  /** Fires when the Job stops being this runner's to report on. */
  signal: AbortSignal;
  log: Logger;
  retryMs?: number;
  patienceMs?: number;
};

/** The wait before attempt `n + 1`, doubling to a ceiling. */
export function backoff(attempt: number, retryMs: number): number {
  return Math.min(retryMs * 2 ** (attempt - 1), MAX_RETRY_MS);
}

/**
 * Offers the completion until the server takes it, the patience runs out, or the
 * Job stops being this runner's.
 *
 * `true` means the outcome is recorded and the workspace is safe to delete.
 * `false` means it is not, and the caller keeps both the artifacts and the slot
 * until it knows what happened to them.
 */
export async function reportCompletion({
  jobId,
  send,
  signal,
  log,
  retryMs = RETRY_MS,
  patienceMs = PATIENCE_MS,
}: Delivery): Promise<boolean> {
  const started = Date.now();

  for (let attempt = 1; ; attempt += 1) {
    // A Job the server took back is not this runner's to report on. Another
    // runner may already hold it, and two outcomes for one jobId is the one
    // thing the store must never accept.
    if (signal.aborted) return false;

    try {
      await send();
      // A retry that worked is otherwise indistinguishable from never having
      // failed, and this is the line that says the Job was nearly lost.
      if (attempt > 1) {
        log.info("the completion was taken", { job_id: jobId, attempt });
      }
      return true;
    } catch (cause) {
      // Checked before anything is written, because the line below announces a
      // wait and a Job that is no longer this runner's gets neither. A runner
      // being stopped rejects the call in flight, and saying "trying again in
      // 1000ms" on the way out describes a retry that never happens.
      if (signal.aborted) return false;

      const delay = backoff(attempt, retryMs);
      const spent = Date.now() - started;

      // Measured against the wait it is about to take rather than after it, so
      // the last thing this does is try, not sleep.
      if (spent + delay >= patienceMs) {
        log.error("the completion was never acknowledged", {
          job_id: jobId,
          attempts: attempt,
          waited_ms: spent,
          ...errorFields(cause),
        });
        return false;
      }

      log.warning("completion was not acknowledged", {
        job_id: jobId,
        attempt,
        delay_ms: delay,
        ...errorFields(cause),
      });

      if (!(await waited(delay, signal))) return false;
    }
  }
}
