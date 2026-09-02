/**
 * A Job whose engine never got an answer from the API.
 *
 * Five Jobs died this way in one minute, each reporting one turn,
 * `$0.00` and `API Error: 529 Overloaded`, and each sending its Run to
 * `needs_human`. Two of them threw away a completed plan. What is asserted here
 * is that the transient one is tried again and the permanent one still is not,
 * and that a Job which keeps hitting it reports exactly what it reports today.
 *
 * Ported whole from the service's own suite: how many attempts,
 * how long between them and which failures are worth another spawn are all the
 * runner's own decision, and the completion carrying the last attempt's words
 * arrives over the wire this double already speaks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createLogger, fakeEngine, startRunner } from "../src/index.ts";
import { startServerDouble, type ServerDouble } from "./server-double.ts";
import { recordingLog } from "./support/recording-log.ts";

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
 * A real turn budget, not one. The failure being retried reports `num_turns: 1`,
 * and against a ceiling of 1 `stopReason` reads that as the ceiling rather than
 * as the API error it was.
 */
const job = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "reply with exactly: OK", maxTurns: 40 },
});

const resultLine = (fields: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    num_turns: 1,
    session_id: "s",
    total_cost_usd: 0,
    subtype: "success",
    ...fields,
  });

/** The recorded shape: one turn, nothing spent, and the API asking for later. */
const OVERLOADED = [
  resultLine({
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 529,
    result: "API Error: 529 Overloaded. This is a server-side issue, usually temporary",
  }),
];
/** `fixtures/stream-api-error.jsonl` in one line: a network that blocks the API. */
const BLOCKED = [
  resultLine({
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 403,
    result: "Failed to authenticate. API Error: 403 Connection blocked by network allowlist",
  }),
];
/** An `api_error` the CLI put no status on. */
const UNCLASSIFIED = [resultLine({ is_error: true, terminal_reason: "api_error", result: "boom" })];
const OK = [resultLine({ is_error: false, terminal_reason: "completed", result: "OK" })];

describe("an engine that stopped because the API was busy", () => {
  test("is tried again, and the Job that was about to be lost completes", async () => {
    const double = await server();
    const engine = fakeEngine({ streams: [OVERLOADED, OK] });
    const runner = await startRunner({
      url: double.url,
      engine,
      engineRetryMs: 5,
      log: quiet,
    });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-1"));

    const completion = await double.completionFor("job-1");
    expect(completion.outcome).toBe("complete");
    expect(completion.artifacts?.["result.md"]).toBe("OK");
    expect(engine.calls).toHaveLength(2);
  });

  test("ends up exactly where it ends up today when waiting never helps", async () => {
    const double = await server();
    const engine = fakeEngine({ streams: [OVERLOADED] });
    const runner = await startRunner({
      url: double.url,
      engine,
      engineRetryMs: 5,
      log: quiet,
    });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-2"));

    const completion = await double.completionFor("job-2");
    // Bounded, and the last attempt's own words: nothing about the failure
    // became invisible for having been retried.
    expect(engine.calls).toHaveLength(3);
    expect(completion.outcome).toBe("failed");
    expect(completion.artifacts?.["result.md"]).toContain("529 Overloaded");
    expect(completion.artifacts?.["engine.txt"]).toContain("api_error");
  });

  test("says which attempt it is on, what stopped it, and how long it is waiting", async () => {
    const double = await server();
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine({ streams: [OVERLOADED] }),
      engineRetryMs: 5,
      log: seen.log,
    });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-3"));
    await double.completionFor("job-3");

    const waits = seen.lines().filter((l) => l.message === "the engine hit a transient API error");
    expect(waits).toHaveLength(2);
    expect(waits[0]?.attempt).toBe(1);
    expect(waits[0]?.terminal_reason).toBe("api_error");
    expect(waits[0]?.api_error_status).toBe(529);
    // Waiting is not spinning, and the spacing grows.
    expect(Number(waits[1]?.delay_ms)).toBeGreaterThan(Number(waits[0]?.delay_ms));
  });
});

describe("an engine that stopped for a reason waiting cannot fix", () => {
  test("the recorded blocked network is reported on the first attempt", async () => {
    const double = await server();
    const engine = fakeEngine({ streams: [BLOCKED] });
    const runner = await startRunner({ url: double.url, engine, engineRetryMs: 5, log: quiet });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-4"));

    const completion = await double.completionFor("job-4");
    expect(engine.calls).toHaveLength(1);
    expect(completion.outcome).toBe("failed");
    expect(completion.artifacts?.["result.md"]).toContain("403");
  });

  test("an api_error carrying no status at all is reported on the first attempt too", async () => {
    const double = await server();
    const engine = fakeEngine({ streams: [UNCLASSIFIED] });
    const runner = await startRunner({ url: double.url, engine, engineRetryMs: 5, log: quiet });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-5"));

    const completion = await double.completionFor("job-5");
    expect(engine.calls).toHaveLength(1);
    expect(completion.outcome).toBe("failed");
  });
});

describe("a cancel that arrives while the runner is waiting to try again", () => {
  /** Long enough that the cancel lands inside the wait rather than after it. */
  const LONG_WAIT = 5_000;

  async function cancelMidWait(jobId: string) {
    const seen = recordingLog();
    const double = await server();
    const engine = fakeEngine({ streams: [OVERLOADED] });
    const runner = await startRunner({
      url: double.url,
      engine,
      engineRetryMs: LONG_WAIT,
      log: seen.log,
    });
    stopAll.push(() => runner.stop());
    await double.helloReceived();

    // The runner's own word for the state every test below starts from: one
    // attempt made, and the engine now inside its retry wait. Registered
    // before the assign that causes it, or the wait has already missed it.
    const waiting = seen.line("the engine hit a transient API error");
    await double.assign(job(jobId));
    await waiting;

    // No wait after the cancel: the runner answers `job.cancel` from the
    // handler that aborts, and the double awaits that answer.
    expect(await double.cancel(jobId, "user_cancelled")).toEqual({ stopped: true, commits: [] });
    return { double, engine, runner };
  }

  test("stops it, rather than leaving a Job the server cannot stop", async () => {
    const jobId = "job-6";
    const { double, engine, runner } = await cancelMidWait(jobId);

    // Draining settles once the runner holds no Job, which it stops doing only
    // at the end of the Job it was told to abandon: the seam for "it is
    // finished", so the count below is read after the only chance to send one.
    await runner.stop({ drain: true });

    expect(engine.calls).toHaveLength(1);
    // A cancelled Job belongs to the server again, so the abandoned attempt's
    // result must never be offered as its outcome.
    expect(double.completionAttempts(jobId)).toBe(0);
  });

  test("leaves no timer behind, so the runner stops without waiting the delay out", async () => {
    const { engine, runner } = await cancelMidWait("job-7");

    const started = Date.now();
    await runner.stop();

    // The line above is the whole proof, and it is why nothing waits here: a
    // wait that was merely ignored would still be pending, and `stop` would
    // have had to sit out the full `LONG_WAIT` before returning.
    expect(Date.now() - started).toBeLessThan(LONG_WAIT);
    expect(engine.calls).toHaveLength(1);
  });
});
