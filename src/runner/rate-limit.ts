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
