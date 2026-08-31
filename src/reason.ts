/**
 * Why the engine stopped, in one sentence a human reading a Run can act on.
 *
 * A Job that ended for a reason the engine named used to lose it: the runner
 * reported `engineResult` and nothing on the server read it, so a code stage
 * that ran 81 turns against a ceiling of 80 arrived as a `failed` Job with an
 * empty `result.md` and no explanation anywhere.
 *
 * Pure, and deliberately here rather than inside the engine: what a reason
 * means depends on the Job's ceiling, which is the runner's to know.
 */

/** What of an `EngineResult` this needs. Narrower than the type, so it is testable. */
export type StopFacts = {
  ok: boolean;
  subtype: string;
  terminalReason: string;
  turns: number;
};

/** The documented subtype the engine reports when it hits the turn ceiling. */
const MAX_TURNS = "error_max_turns";

/**
 * The sentence, or nothing when the engine ended cleanly: the ordinary case
 * says nothing extra, because a note on every Job is a note nobody reads.
 *
 * The ceiling is recognised two ways, because one is not enough. The subtype is
 * the documented signal, and `fixtures/stream-api-error.jsonl` shows it carrying
 * `success` on a run that failed, so the turn count is the defensive path. It
 * only applies to a run that did not end cleanly, so a success that used its
 * last turn is not accused of stopping at the ceiling.
 */
export function stopReason(result: StopFacts, maxTurns: number): string | undefined {
  if (result.ok) return undefined;

  if (result.subtype === MAX_TURNS || (maxTurns > 0 && result.turns >= maxTurns)) {
    return `the engine stopped at the turn ceiling: ${result.turns} turns against a maximum of ${maxTurns}`;
  }

  const named = result.terminalReason.trim() || result.subtype.trim();
  if (named) return `the engine stopped after ${result.turns} turns: ${named}`;

  return `the engine stopped after ${result.turns} turns and named no reason`;
}

/** What `retryable` reads. Again narrower than `EngineResult`, and disjoint from `StopFacts`. */
export type RetryFacts = {
  ok: boolean;
  terminalReason: string;
  apiErrorStatus?: number;
  turns: number;
  costUsd: number;
};

/** The reason class the API's own status is attached to. */
const API_ERROR = "api_error";

/**
 * The floor for "the server said come back later". 5xx is the API admitting it
 * could not serve the request; every 4xx is something about the request itself,
 * and `fixtures/stream-api-error.jsonl` is the recorded 403 that three more
 * spawns would not have helped. 429 is under the floor on purpose: the CLI
 * reports a rate limit as its own event carrying the reset time, and that wait
 * is hours, so it belongs in front of a person rather than in a backoff.
 */
const TRANSIENT_STATUS = 500;

/**
 * Could waiting help. Not "should we wait again": how many attempts are left
 * and how long to wait are the caller's, and this stays a pure question about
 * one result.
 *
 * The subtype is deliberately not read. `fixtures/stream-api-error.jsonl`
 * carries `subtype: "success"` on a run that failed, so trusting it here would
 * be trusting the one field measured to lie about this exact case.
 *
 * A run that did any work is never retried. The five Jobs this was built for
 * all reported one turn and nothing spent, so there was nothing to throw away;
 * an engine that spent forty turns and then hit a 529 has a partial result
 * worth more than a clean restart, and deciding what to do with it is not this.
 */
export function retryable(facts: RetryFacts): boolean {
  if (facts.ok) return false;
  if (facts.terminalReason !== API_ERROR) return false;
  if (facts.apiErrorStatus === undefined || facts.apiErrorStatus < TRANSIENT_STATUS) return false;
  return facts.turns <= 1 && facts.costUsd === 0;
}
