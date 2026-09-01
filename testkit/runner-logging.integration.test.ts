/**
 * What the runner says about itself while it works.
 *
 * The line that matters most here is the workspace one: a Stage handed no
 * checkout runs against an empty directory, and from the outside that looks
 * exactly like a Stage exploring a repository. It cost a whole smoke to find
 * once already.
 *
 * Ported whole from the service's own suite, minus the one
 * case that never needed a server on either side: how `createLogger` shapes an
 * engine event is a unit test, and it lives in src/log.test.ts now.
 *
 * The three reconnect cases used to wait out a fixed 300ms and count what had
 * accumulated. They wait on the lines themselves here, and say what the counts
 * mean instead: one chain, and a delay that actually grows.
 */
import { afterEach, describe, expect, test } from "vitest";
import { fakeEngine, REFUSED_HANDSHAKE, startRunner } from "../src/index.ts";
import { startServerDouble, type ServerDouble } from "./server-double.ts";
import { recordingLog, type RecordingLog } from "./support/recording-log.ts";

const stopAll: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const stop of stopAll.reverse()) await stop();
  stopAll.length = 0;
});

/**
 * The one wait here that is not on an event. What follows it asserts that
 * nothing more was written, and an absence has no line to wait for.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function pairThatLogs(): Promise<{ double: ServerDouble; seen: RecordingLog }> {
  const double = await startServerDouble();
  stopAll.push(() => double.stop());
  const seen = recordingLog();
  const runner = await startRunner({ url: double.url, engine: fakeEngine(), log: seen.log });
  stopAll.push(() => runner.stop());
  await double.helloReceived();
  return { double, seen };
}

const said = (seen: RecordingLog, message: string) =>
  seen.lines().filter((l) => l.message === message);

const job = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "reply with exactly: OK", maxTurns: 1 },
});

describe("the runner's own logs", () => {
  test("says what it declared when it connects", async () => {
    const { seen } = await pairThatLogs();

    const connected = await seen.line("connected");
    expect(connected.slots).toBe(1);
    expect(connected.stages).toEqual(["plan", "code", "pr", "eval"]);
    expect(connected.runner_id).toBeTruthy();
    expect(connected.service).toBe("crewbit-runner");
  });

  test("names a Job it took, with the turn budget it was given", async () => {
    const { double, seen } = await pairThatLogs();

    await double.assign(job("job-1"));
    await double.completionFor("job-1");

    const [accepted] = said(seen, "job accepted");
    expect(accepted?.stage).toBe("plan");
    expect(accepted?.max_turns).toBe(1);
    expect(accepted?.resuming).toBe(false);
  });

  test("reports whether the workspace got a repository or an empty directory", async () => {
    const { double, seen } = await pairThatLogs();

    await double.assign(job("job-2"));
    const ready = await seen.line("workspace ready");

    expect(ready.path).toBeTruthy();
    // No repo on this Job, so nothing was cloned. That is the condition an
    // agent told to "explore the codebase" fails silently on.
    expect(ready.cloned).toBe(false);
    expect(ready.context_files).toEqual([]);
  });

  test("reports a Job whose engine failed, with what went wrong", async () => {
    const double = await startServerDouble();
    stopAll.push(() => double.stop());
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: {
        kind: "broken",
        version: "0",
        run: () => Promise.reject(new Error("claude is not on PATH")),
      },
      log: seen.log,
    });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-3"));
    const failed = await seen.line("job failed");

    expect(failed.status).toBe("error");
    expect(failed.stage).toBe("plan");
    expect(failed["error.message"]).toBe("claude is not on PATH");
  });
});

describe("a runner whose server went away", () => {
  /** A runner left dialling a port nobody is listening on any more. */
  async function orphaned(): Promise<RecordingLog> {
    const double = await startServerDouble();
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine(),
      reconnectMs: 10,
      log: seen.log,
    });
    stopAll.push(() => runner.stop());
    await double.helloReceived();
    await double.stop();
    return seen;
  }

  test("numbers the attempt it is reporting, on one chain", async () => {
    const seen = await orphaned();

    await seen.waitForCount("reconnecting", 3);

    // Three, because an off-by-one passes a single line. The line carries the
    // error of the attempt that failed and the wait that preceded it, so the
    // number beside them is that attempt's: reading the counter instead
    // reported the *next* one, because a failed connect fires `close`, and
    // close schedules before the rejection reaches this catch.
    //
    // It is also the one-chain check. Both paths used to schedule and each of
    // those scheduled two more, doubling the count every attempt, which shows
    // up here as a repeat or a jump.
    const attempts = said(seen, "reconnecting").map((l) => Number(l.attempt));
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3]);
  });

  test("actually backs off, instead of resetting to the first delay", async () => {
    const seen = await orphaned();

    await seen.waitForCount("reconnecting", 3);

    // The close path used to call `scheduleReconnect` with no argument, so the
    // attempt counter went back to zero and every delay was the first one.
    const delays = said(seen, "reconnecting").map((l) => l.delay_ms as number);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
  });

  test("stops trying once it is stopped, rather than leaving a timer to fire", async () => {
    const double = await startServerDouble();
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine(),
      reconnectMs: 10,
      log: seen.log,
    });
    await double.helloReceived();
    await double.stop();
    await seen.waitForCount("reconnecting", 1);

    await runner.stop();
    const beforeStop = said(seen, "reconnecting").length;
    await settle();

    // The reconnect timer holds the event loop open, which is what lets a
    // runner outlive its server. The price is that a pending one nobody
    // cancels is a process nobody can end, so `stop()` clearing it stopped
    // being incidental.
    expect(said(seen, "reconnecting")).toHaveLength(beforeStop);
  });
});

describe("a runner that was never let in", () => {
  test("leaves no reconnect chain behind, since its caller has nothing to stop", async () => {
    const double = await startServerDouble();
    const url = double.url;
    await double.stop();
    const seen = recordingLog();

    const failed = await startRunner({
      url,
      engine: fakeEngine(),
      reconnectMs: 10,
      log: seen.log,
    }).catch((error: Error) => error);

    expect(failed).toBeInstanceOf(Error);
    await settle();

    // The failed socket's `close` has already scheduled a reconnect by the time
    // the caller is handed the error, and it was handed no handle: a chain
    // started here is a timer nothing can cancel, in a process nothing can end.
    expect(said(seen, "reconnecting")).toHaveLength(0);
    expect(String(failed)).not.toContain(REFUSED_HANDSHAKE);
  });
});
