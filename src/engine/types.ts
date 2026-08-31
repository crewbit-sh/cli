/**
 * The engine boundary. Claude Code through its CLI today, the Agent SDK with an
 * API key as the fallback: the runner only ever sees this interface, which is
 * what keeps tests free of both.
 */

import type { JobEvent } from "@crewbit/protocol";

/**
 * The same set the protocol carries. An engine event the wire cannot express
 * would be useless to the runner, and two copies of one union drift.
 */
export type EngineEvent = JobEvent;

export type EngineResult = {
  ok: boolean;
  /** The engine's final answer. */
  text: string;
  sessionId: string;
  turns: number;
  /** Under a subscription this is a locally computed estimate, not a bill. */
  costUsd: number;
  subtype: string;
  terminalReason: string;
  /**
   * The run stopped because it exhausted its turn or budget ceiling, rather
   * than breaking. Set only when that is what happened, so an engine that never
   * produced a result is never mistaken for one that ran out of room.
   */
  ceiling?: boolean;
  /**
   * The HTTP status behind a `terminal_reason: "api_error"`. Set only when the
   * engine reported one, because absence and a status are different answers:
   * a 529 is worth waiting out and a 403 never will be.
   */
  apiErrorStatus?: number;
};

export type EngineRun = {
  prompt: string;
  cwd: string;
  maxTurns: number;
  allowedTools?: string[];
  permissionMode?: string;
  model?: string;
  resumeSessionId?: string;
  /** Spend ceiling for the run. Hitting it is a `partial` outcome, not a failure. */
  maxBudgetUsd?: number;
  /**
   * Stops the run. An engine that spawns subprocesses must take the whole group
   * down, or the workspace stays busy after the Job is gone.
   */
  signal?: AbortSignal;
  /** Called as events arrive, not at the end. */
  onEvent: (event: EngineEvent) => void;
};

export interface Engine {
  readonly kind: string;
  readonly version: string;
  run(run: EngineRun): Promise<EngineResult>;
}
