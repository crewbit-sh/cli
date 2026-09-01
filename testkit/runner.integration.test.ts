/**
 * The real runner against this double, not the hand-rolled peer the double's
 * own tests use: this file is where a failure means the runner broke, not
 * the double.
 */
import { afterEach, describe, expect, test } from "vitest";
import { createLogger, startRunner } from "../src/index.ts";
import { startServerDouble, type ServerDouble } from "./server-double.ts";
import { blockingEngine } from "./support/blocking-engine.ts";

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

describe("a Job whose engine runs long", () => {
  test("the runner sends job.status on its own, without being told, while it works", async () => {
    const double = await server();
    const { engine, release } = blockingEngine();
    const runner = await startRunner({ url: double.url, log: quiet, engine });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    const accepted = await double.assign({
      jobId: "job-1",
      runId: "run-1",
      stage: "plan",
      context: {},
      harness: { prompt: "do the thing", maxTurns: 1 },
      // Small on purpose: the keepalive fires at a third of the lease
      // (packages/cli's `keepaliveMs`), so this is what makes waiting for one
      // a matter of milliseconds instead of the production hour.
      leaseSeconds: 1,
    });
    expect(accepted).toEqual({ accepted: true });

    // The first is "preparing", the second is the explicit "working, engine
    // starting" sent once. Nobody sends a third: the engine above is still
    // blocked on `release`, so only the keepalive interval firing again and
    // again produces one. This is the half of "holds its claim while the
    // engine is still working" that moved here from crewbit-v2's
    // leases.test.ts -- the dispatcher's own reaction to a status arriving is
    // that file's, proven there with one sent by hand.
    await double.waitForStatus("job-1", 3);
    const statuses = double.statuses("job-1");
    expect(statuses.slice(1).every((s) => s.status === "working")).toBe(true);

    release();
    expect((await double.completionFor("job-1")).outcome).toBe("complete");
  });
});
