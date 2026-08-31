/**
 * Event batching, per Job.
 *
 * A chatty stage produces hundreds of messages and one frame each is waste, so
 * events accumulate and flush on whichever comes first: a full batch, the
 * interval, or an explicit flush at a status change.
 *
 * The numbers are a starting point rather than a finding. Real usage data is
 * what would justify changing them.
 */

import type { JobEvent } from "@crewbit/protocol";

export const MAX_BATCH = 25;
export const FLUSH_MS = 250;

export type Batcher = {
  push(event: JobEvent): void;
  flush(): void;
  /** Sends what is pending and stops the timer. Idempotent. */
  stop(): void;
  /** The last sequence sent, which is what a reconnect declares as `lastSeq`. */
  lastSeq(): number;
};

export function createBatcher(
  onFlush: (seq: number, events: JobEvent[]) => void,
  options: { intervalMs?: number } = {},
): Batcher {
  let pending: JobEvent[] = [];
  let seq = 0;
  let stopped = false;

  const timer = setInterval(() => flush(), options.intervalMs ?? FLUSH_MS);
  // Reporting must not be the reason a process stays alive.
  timer.unref?.();

  function flush(): void {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    seq += 1;
    onFlush(seq, batch);
  }

  return {
    push(event) {
      if (stopped) return;
      pending.push(event);
      if (pending.length >= MAX_BATCH) flush();
    },
    flush,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // The tail of a Job is the part that says how it ended.
      flush();
    },
    lastSeq: () => seq,
  };
}
