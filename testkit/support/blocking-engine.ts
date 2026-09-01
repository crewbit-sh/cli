/**
 * An engine that stays in the middle of a Job until the test lets it go.
 *
 * Every case about what the runner does *while* it is working needs one: a
 * drain that must not kill it, a keepalive that has to keep ticking, a socket
 * that drops mid-Job, a cancel that has to reach it. There were four copies of
 * it by the time the cancel tests arrived, each recording a little less than
 * the next needed.
 */
import type { Engine } from "../../src/index.ts";

export type BlockingEngine = {
  engine: Engine;
  /** Resolves the moment the engine is actually working on a Job. */
  running: Promise<void>;
  /** Lets the current run finish. Aborting the Job does the same thing. */
  release(): void;
  state: {
    /** How many times the engine was spawned, which is what a resumed Job must not increase. */
    runs: number;
    aborted: boolean;
  };
};

export function blockingEngine(options: { emits?: boolean } = {}): BlockingEngine {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const state = { runs: 0, aborted: false };

  const engine: Engine = {
    kind: "blocking",
    version: "0",
    async run(run) {
      state.runs += 1;
      // Tagged, so a completion can be traced to the run that produced it. The
      // shared release makes a later run return at once, and without the tag
      // its output is indistinguishable from the abandoned one's.
      const label = `run ${state.runs}`;
      const stopped = () => {
        state.aborted = true;
        release();
      };
      // Already aborted before the listener is added is a real case: a Job
      // cancelled while its workspace is still being prepared arrives with the
      // signal set, and `abort` does not fire again. `claude-cli.ts` returns
      // early on it, and a fake that only listens hangs instead.
      if (run.signal?.aborted) stopped();
      else run.signal?.addEventListener("abort", stopped);
      if (options.emits) run.onEvent?.({ t: "assistant", text: "working" });
      started();
      await blocked;

      const cancelled = run.signal?.aborted === true;
      return {
        ok: !cancelled,
        text: cancelled ? "cancelled" : label,
        sessionId: "s",
        turns: 1,
        costUsd: 0,
        subtype: cancelled ? "error" : "success",
        terminalReason: cancelled ? "cancelled" : "completed",
      };
    },
  };

  return { engine, state, running, release: () => release() };
}
