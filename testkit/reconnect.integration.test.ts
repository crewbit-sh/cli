/**
 * A dropped connection is the common case, not the exception: a laptop sleeps,
 * a proxy resets, a server restarts. What the runner does with the window the
 * lease gives it is all its own: dial again on a backoff, declare what it is
 * still holding and how far its transcript got, and drop a Job the answer says
 * is no longer its.
 *
 * Ported from crewbit-v2's test/reconnect.test.ts. Whether the lease has
 * actually expired stays there, and so does the one case this file does not
 * carry: that a replayed batch leaves no duplicate in the transcript is the
 * server's composite key doing it, and proving it needs the store. The
 * runner's half of that case is here, as the `lastSeq` the second handshake
 * declares.
 */
import { afterEach, describe, expect, test } from "vitest";
import { createLogger, type Engine, startRunner } from "../src/index.ts";
import { startServerDouble, type ServerDouble } from "./server-double.ts";
import { recordingLog } from "./support/recording-log.ts";

/** These tests drop connections on purpose, and the logs are not what they assert. */
const quiet = createLogger("test", () => {});
const stopAll: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const stop of stopAll.reverse()) await stop();
  stopAll.length = 0;
});

async function server(): Promise<ServerDouble> {
  const double = await startServerDouble();
  stopAll.push(() => double.stop());
  return double;
}

/**
 * Blocks until released, so a Job is still in flight when the socket drops,
 * and records what happened to it: which run produced an answer, and whether
 * the run was told to stop. Its own rather than drain's, which needs neither.
 */
function blockingEngine(options: { emits?: boolean } = {}) {
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
      // signal set, and `abort` does not fire again.
      if (run.signal?.aborted) stopped();
      else run.signal?.addEventListener("abort", stopped);
      if (options.emits) run.onEvent?.({ t: "assistant", text: "working" });
      started();
      await blocked;
      return {
        ok: true,
        text: label,
        sessionId: "s",
        turns: 1,
        costUsd: 0,
        subtype: "success",
        terminalReason: "completed",
      };
    },
  };

  return { engine, state, running, release: () => release() };
}

async function runnerOn(double: ServerDouble, engine: Engine, log = quiet) {
  const runner = await startRunner({
    url: double.url,
    engine,
    log,
    // Short, so a test does not wait on a production backoff.
    reconnectMs: 30,
    runnerId: "runner_fixed",
  });
  stopAll.push(() => runner.stop());
  await double.helloReceived();
  return runner;
}

const job = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "go", maxTurns: 1 },
});

describe("a dropped connection", () => {
  test("comes back on its own", async () => {
    const double = await server();
    const runner = await runnerOn(double, blockingEngine().engine);

    runner.disconnect();

    // The second handshake is the reconnect, and waiting for it is waiting for
    // the thing itself rather than for the backoff to have been long enough.
    await double.waitForHello(2);
    expect(double.hellos()).toHaveLength(2);
  });

  test("declares the Job it still holds, and is told to keep it", async () => {
    const double = await server();
    const slow = blockingEngine();
    const runner = await runnerOn(double, slow.engine);
    await double.assign(job("job-1"));
    await slow.running;

    double.resumeWith("job-1", { ackedSeq: 0, stillMine: true });
    runner.disconnect();
    await double.waitForHello(2);

    expect(double.hellos()[1]?.activeJobs).toEqual([{ jobId: "job-1", lastSeq: 0 }]);
    // Still the same run: the engine was never restarted, and nothing told it
    // to stop.
    expect(slow.state.runs).toBe(1);
    expect(slow.state.aborted).toBe(false);
  });

  test("says how far its transcript got, so the server can drop what it already has", async () => {
    const double = await server();
    const slow = blockingEngine({ emits: true });
    const runner = await runnerOn(double, slow.engine);
    await double.assign(job("job-2"));
    // The batch landing is what moves the sequence, so this is the seam: a
    // reconnect before it would honestly declare 0.
    await double.waitForEvent("job-2", 1);

    double.resumeWith("job-2", { ackedSeq: 1, stillMine: true });
    runner.disconnect();
    await double.waitForHello(2);

    expect(double.hellos()[1]?.activeJobs).toEqual([{ jobId: "job-2", lastSeq: 1 }]);
  });

  test("finishes the Job it was holding, over the new connection", async () => {
    const double = await server();
    const slow = blockingEngine();
    const runner = await runnerOn(double, slow.engine);
    await double.assign(job("job-3"));
    await slow.running;

    double.resumeWith("job-3", { ackedSeq: 0, stillMine: true });
    runner.disconnect();
    await double.waitForHello(2);
    slow.release();

    const completion = await double.completionFor("job-3");
    expect(completion.outcome).toBe("complete");
    // The run that was interrupted, not a second one: the socket died, the Job
    // did not.
    expect(completion.artifacts?.["result.md"]).toBe("run 1");
  });
});

describe("a Job that was handed on while the runner was away", () => {
  test("is abandoned rather than reported twice", async () => {
    const double = await server();
    const seen = recordingLog();
    const slow = blockingEngine();
    const runner = await runnerOn(double, slow.engine, seen.log);
    await double.assign(job("job-4"));
    await slow.running;

    // The lease ran out while the socket was down, so the Job is no longer this
    // runner's to finish, and the handshake is where it finds out.
    double.resumeWith("job-4", { ackedSeq: 0, stillMine: false });
    const abandoned = seen.line("job no longer mine, abandoning");
    runner.disconnect();
    await abandoned;

    // Draining settles once the Job is finished with, which is after the only
    // point it could have reported an outcome.
    await runner.stop({ drain: true });

    expect(slow.state.aborted).toBe(true);
    // Another runner may already hold this Job, and two outcomes for one jobId
    // corrupt the Run.
    expect(double.completionAttempts("job-4")).toBe(0);
  });
});
