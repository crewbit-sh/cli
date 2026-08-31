/**
 * What a Stage reports, decided from what it produced.
 *
 * A pure function, and that is the point of the file rather than a style
 * preference: this is where the Run goes next, and it used to live inside
 * `execute` where the only way to reach a branch of it was to start a
 * dispatcher, open a socket, clone a repository and push to it. Twelve of those
 * at six seconds each covered what the table below covers in milliseconds, and
 * the two defects this repository actually shipped in this area were both
 * decisions with no unit test over them and green integration tests around
 * them.
 */

import type { JobAssignParams, JobCompleteParams } from "@crewbit/protocol";

export type Outcome = JobCompleteParams["outcome"];

export type OutcomeInput = {
  /**
   * What the delivery guard concluded. `"failed"` outranks everything below,
   * because reporting anything else about work that is not on the remote is
   * what makes the fix loop chase a criterion the code already satisfies.
   */
  problem?: "failed";
  /** The engine's own answer: whether it finished, and whether it ran out of turns. */
  result: { ok: boolean; ceiling?: boolean };
  /** What the Job declared about which file means what. */
  artifacts?: JobAssignParams["artifacts"];
  /** What was actually collected off the workspace. */
  collected: Record<string, string>;
  /**
   * The project's own check, when one ran *after* the engine.
   *
   * Deliberately not the pre-engine check a non-delivering Stage runs: that one
   * decides whether the agent runs at all, and a Stage it stopped never reaches
   * here. Conflating the two would let a check that ran instead of the engine
   * flip an outcome the engine never produced.
   */
  checked?: { exitCode: number };
};

export type Decided = {
  outcome: Outcome;
  /**
   * True when a green-looking Stage was failed by a red check, which is the one
   * case worth a log line: every other path to `failed` already says why.
   */
  flipped: boolean;
};

export function decide(input: OutcomeInput): Decided {
  const outcome = reported(input);
  // A red check turns a would-be `complete` into `failed` and upgrades nothing
  // else. The two conditions above it are different from a broken change, the
  // fix loop needs them apart, and the check says nothing new about either.
  // Because only `complete` flips, the note this produces can never overwrite a
  // `blocked.md` the agent wrote: that one is already `failed`.
  const flipped =
    outcome === "complete" && input.checked !== undefined && input.checked.exitCode !== 0;
  return { outcome: flipped ? "failed" : outcome, flipped };
}

function reported({ problem, result, artifacts, collected }: OutcomeInput): Outcome {
  if (problem) return problem;
  // A run that stopped at its ceiling is `partial` whichever file it wrote,
  // including none and including `pr-body.md`. Incomplete-by-budget is not
  // broken, and a fix round can solve one and not the other.
  if (result.ceiling) return "partial";
  if (!result.ok) return "failed";
  return fromArtifacts(artifacts, collected);
}

function fromArtifacts(
  spec: JobAssignParams["artifacts"],
  collected: Record<string, string>,
): Outcome {
  if (!spec) return "complete";

  for (const { file, outcome } of spec.outcomes) {
    if (file in collected) return outcome;
  }

  // Writing none of them is a failure, never a silent success.
  return "failed";
}
