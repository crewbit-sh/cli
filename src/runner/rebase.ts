/**
 * What a rebase Job reports, decided from what the git mechanics found.
 *
 * A pure function, and that is the point of the file rather than a style
 * preference - `outcome.ts` is the same shape for the ordinary engine path,
 * for the same reason: the alternative is a decision reachable only by
 * standing up a server, cloning a repository and pushing to it.
 */

import type { JobCompleteParams } from "@crewbit/protocol";

/** No engine ran, so nothing here did either - #328's own acceptance criterion. */
export const NO_ENGINE_SESSION = { id: "", turns: 0, costUsd: 0, durationMs: 0 };

export type RebaseOutcome =
  /** The Job carried no repository grant, which a rebase cannot do anything without. */
  | { kind: "no_repo" }
  /**
   * The rebase could not apply cleanly. The one thing this cannot resolve on
   * its own: today's fix loop takes it from here, the same way it already
   * does for a branch delivered behind its base.
   */
  | { kind: "conflict"; conflict: string; changedFiles: string }
  /** The rebase applied, or there was nothing to rebase, and the branch was pushed. */
  | {
      kind: "delivered";
      commits: string[];
      artifacts?: Record<string, string>;
      problem?: "failed";
    };

export function rebaseCompletion(jobId: string, outcome: RebaseOutcome): JobCompleteParams {
  if (outcome.kind === "no_repo") {
    return {
      jobId,
      outcome: "failed",
      artifacts: {
        "error.txt": "a rebase Job needs a repository grant, and this one carries none",
      },
    };
  }

  if (outcome.kind === "conflict") {
    return {
      jobId,
      outcome: "failed",
      artifacts: {
        "conflict.txt": outcome.conflict,
        "changed-files.txt": outcome.changedFiles,
      },
      session: NO_ENGINE_SESSION,
    };
  }

  return {
    jobId,
    outcome: outcome.problem ?? "complete",
    artifacts: outcome.artifacts ?? {},
    commits: outcome.commits,
    session: NO_ENGINE_SESSION,
  };
}
