/**
 * The real runner against this double, not the hand-rolled peer the double's
 * own tests use: this file is where a failure means the runner broke, not
 * the double.
 */
import { describe, expect, test } from "bun:test";
import { fakeEngine, startRunner } from "../src/index.ts";
import { blockingEngine } from "./support/blocking-engine.ts";
import { integrationHarness } from "./support/harness.ts";

const { quiet, stopAll, server } = integrationHarness();

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
      harness: { prompt: "do the thing" },
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
    // engine is still working" that moved here from the service's own suite.
    // The server's reaction to a status arriving stays there, proven with one
    // sent by hand.
    await double.waitForStatus("job-1", 3);
    const statuses = double.statuses("job-1");
    expect(statuses.slice(1).every((s) => s.status === "working")).toBe(true);

    release();
    expect((await double.completionFor("job-1")).outcome).toBe("complete");
  });
});

describe("cli#38: a fresh grant answered back on job.status", () => {
  test("a Job completes normally when the server hands one back mid-round", async () => {
    const double = await server();
    const { engine, release } = blockingEngine();
    const runner = await startRunner({ url: double.url, log: quiet, engine });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    // Scripted before the assign, so even the first "preparing" status this
    // Job sends comes back carrying it - the shape a server close to a Job's
    // token expiring would answer with from the very start of a resumed round.
    double.answerStatusWith("job-2", {
      url: "https://github.com/acme/api.git",
      baseBranch: "main",
      branch: "crewbit/spec-2",
      token: "fresh-token",
      tokenExpiresAt: "2026-09-13T19:00:00Z",
    });
    const accepted = await double.assign({
      jobId: "job-2",
      runId: "run-2",
      stage: "plan",
      context: {},
      harness: { prompt: "do the thing" },
      leaseSeconds: 1,
    });
    expect(accepted).toEqual({ accepted: true });

    await double.waitForStatus("job-2", 1);

    expect(double.sawStatusAsRequest("job-2")).toBe(true);
    release();
    expect((await double.completionFor("job-2")).outcome).toBe("complete");
  });
});

/**
 * The protocol's v1 rule, and the reason a field can be retired from one side at
 * a time: adding an optional field is a compatible change, so a runner meeting
 * one it has no idea about ignores it rather than refusing the Job.
 *
 * `harness.maxTurns` is exactly this now. It is not named here on purpose - the
 * whole point of retiring it is that this runner no longer tells it apart from
 * any other field it does not recognise, and naming it would put the field back
 * into a tree that has to keep typechecking once the protocol drops it.
 *
 * Over the socket rather than beside a module because there is no branch to
 * reach: the property is the *absence* of validation between the frame and
 * `execute`, and nothing below the wire can observe it.
 */
describe("a Job from a server this runner is older or newer than", () => {
  test("a harness field it does not recognise is ignored, not refused", async () => {
    const double = await server();
    const runner = await startRunner({ url: double.url, log: quiet, engine: fakeEngine() });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    // Not a literal in the `harness` position, so the excess-property check does
    // not see it - which is the same way it arrives off a real socket.
    const harness = { prompt: "reply with exactly: OK", somethingThisRunnerNeverHeardOf: 80 };
    const accepted = await double.assign({
      jobId: "job-3",
      runId: "run-3",
      stage: "plan",
      context: {},
      harness,
    });

    expect(accepted).toEqual({ accepted: true });
    const completion = await double.completionFor("job-3");
    expect(completion.outcome).toBe("complete");
    // Nothing about the field reached the report either way.
    expect(JSON.stringify(completion)).not.toContain("somethingThisRunnerNeverHeardOf");
  });
});
