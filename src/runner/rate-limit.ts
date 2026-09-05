/**
 * Whether a `rate_limit` event is a real block, or the engine working through it.
 *
 * Claude Code's `rate_limit_info.status` is `allowed`, `allowed_warning` or
 * `rejected` (anthropics/claude-agent-sdk-python#599,
 * anthropics/claude-code#50518); only `rejected` is a block. The runner used to
 * report every `rate_limit` event as "the window is exhausted", so a
 * `five_hour` warning with the engine still working reached the server the
 * same way an actual rejection would, and a Job that later failed for any
 * other reason was requeued until the reset time on the strength of it.
 *
 * `status` is optional because the engine's contract for it is undocumented:
 * absent means unknown, never means fine, so a report with no status is a
 * block for this function's purposes, the same as `rejected`.
 */

import type { JobEvent } from "@crewbit/protocol";

/** What this needs of a `rate_limit` engine event. */
export type RateLimitFacts = {
  rateLimitType: string;
  status?: string;
};

const SAFE_STATUSES = new Set(["allowed", "allowed_warning"]);

/** The engine kept working: nothing here for a person to act on. */
export function rateLimitIsSafe(event: RateLimitFacts): boolean {
  return SAFE_STATUSES.has(event.status ?? "");
}

/**
 * The message for a `human.notify`, for the cases `rateLimitIsSafe` says are
 * not. `@crewbit/protocol`'s `HumanNotifyParams` carries no `status` field, so
 * a confirmed block names it in the message rather than growing the payload
 * for the one caller that needs it.
 */
export function rateLimitMessage(event: RateLimitFacts): string {
  return event.status === "rejected"
    ? `the ${event.rateLimitType} window is exhausted (status: rejected)`
    : `the ${event.rateLimitType} window's status is unknown`;
}

/**
 * Collapses a run of safe `rate_limit` events into one line, #11.
 *
 * The engine emits one on every call while a window is near its limit, and a
 * long stage throttled for its whole run recorded hundreds of identical
 * lines carrying no information beyond "still throttled". The first of a run
 * reaches `push` as it arrives, so the transcript says promptly that the
 * engine is throttled; the rest are only counted, and the count reaches
 * `push` as one closing event, in the same shape, when a different event
 * arrives or `flush` is called with nothing left to wait for. A `rejected`
 * event is never coalesced: it is the one status a person has to see.
 *
 * `@crewbit/protocol`'s `JobEvent` has no field for a count, so it travels in
 * `rateLimitType` itself: "five_hour" becomes "five_hour × 41", which is what
 * the Run page already renders inside `rate limit (${rateLimitType})`.
 */
export function coalesceRateLimits(push: (event: JobEvent) => void): {
  push(event: JobEvent): void;
  flush(): void;
} {
  let run: { rateLimitType: string; resetsAt: number; status?: string; count: number } | undefined;

  function flush(): void {
    if (!run) return;
    if (run.count > 1) {
      push({
        t: "rate_limit",
        rateLimitType: `${run.rateLimitType} × ${run.count}`,
        resetsAt: run.resetsAt,
        status: run.status,
      });
    }
    run = undefined;
  }

  return {
    push(event) {
      if (event.t !== "rate_limit" || !rateLimitIsSafe(event)) {
        flush();
        push(event);
        return;
      }
      if (!run || event.rateLimitType !== run.rateLimitType) {
        flush();
        run = {
          rateLimitType: event.rateLimitType,
          resetsAt: event.resetsAt,
          status: event.status,
          count: 1,
        };
        push(event);
        return;
      }
      run.resetsAt = event.resetsAt;
      run.status = event.status;
      run.count += 1;
    },
    flush,
  };
}
