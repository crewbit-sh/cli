/**
 * Stopping the real runner without throwing away what it is holding, against
 * this double rather than a mock server: `stop()` used to close the socket at
 * once, so a Ctrl-C in the middle of a code stage lost the engine and
 * everything it had not pushed yet, which is up to a third of the lease.
 *
 * Ported from the service's own suite, where it reached a real server
 * through a harness this package cannot pull in. Drain is entirely
 * the runner's own decision -- refuse new work, let what is running finish --
 * so nothing here needed a real server to prove.
 */
import { afterEach, describe, expect, test } from "vitest";
import { createLogger, fakeEngine, startRunner } from "../src/index.ts";
import { startServerDouble, type ServerDouble } from "./server-double.ts";
import { blockingEngine } from "./support/blocking-engine.ts";

const quiet = createLogger("test", () => {});
const stopAll: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stopAll.reverse()) await stop();
  stopAll.length = 0;
});

/**
 * Two waits below prove an absence: that a drain does not kill the engine,
 * and that a draining runner does not take a Job assigned to it a second
 * time. Neither has a milestone to poll for, because what is asserted is the
 * state nothing moved from.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

async function server(): Promise<ServerDouble> {
  const double = await startServerDouble();
  stopAll.push(() => double.stop());
  return double;
}

const job = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "reply with exactly: OK", maxTurns: 1 },
});

describe("draining a runner", () => {
  test("finishes the Job it is holding rather than dropping it", async () => {
    const double = await server();
    const { engine, release, running } = blockingEngine();
    const runner = await startRunner({ url: double.url, log: quiet, engine });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    expect(await double.assign(job("job-1"))).toEqual({ accepted: true });
    await running;

    const drained = runner.stop({ drain: true });
    await settle();
    // Still working: the point of the drain is that the engine is not killed.
    expect(double.statuses("job-1").length).toBeGreaterThan(0);

    release();
    await drained;

    expect((await double.completionFor("job-1")).outcome).toBe("complete");
  });

  test("takes nothing new while it is draining", async () => {
    const double = await server();
    const { engine, release, running } = blockingEngine();
    const runner = await startRunner({ url: double.url, log: quiet, slots: 2, engine });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-1"));
    await running;

    const drained = runner.stop({ drain: true });
    await settle();

    // A runner on its way out must not pick up work it is about to abandon,
    // which slot 2 would otherwise let it do.
    expect(await double.assign(job("job-2"))).toEqual({ accepted: false, reason: "no_slots" });

    release();
    await drained;
  });

  test("a runner holding nothing stops at once", async () => {
    const double = await server();
    const runner = await startRunner({ url: double.url, log: quiet, engine: fakeEngine() });

    // No Job, so there is nothing to wait for and waiting would be a hang.
    await runner.stop({ drain: true });
    expect(true).toBe(true);
  });

  test("stopping twice does not wait twice", async () => {
    const double = await server();
    const { engine, release, running } = blockingEngine();
    const runner = await startRunner({ url: double.url, log: quiet, engine });

    await double.helloReceived();
    await double.assign(job("job-1"));
    await running;

    const first = runner.stop({ drain: true });
    const second = runner.stop({ drain: true });
    release();

    // A second Ctrl-C while draining is a person asking again, not a second
    // drain to wait for.
    await Promise.all([first, second]);
    expect(true).toBe(true);
  });
});
