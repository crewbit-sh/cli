/**
 * A Job the server has taken back, from the runner's side of it. The hazard
 * this guards is two outcomes for one `jobId`: duplicate work is recoverable,
 * a duplicate outcome corrupts the Run.
 *
 * The runner half of a pair the service's own suite holds. What made the server
 * send the cancel stays there, because an expired lease, a reclaim budget and
 * a Job given up on are all decisions taken against a store. What arrives here
 * is the same frame either way, and everything the runner does about it is
 * below: stop the engine, say nothing about the run it abandoned, and give the
 * slot back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createLogger, fakeEngine, startRunner } from "../src/index.ts";
import { startServerDouble, type ServerDouble } from "./server-double.ts";
import { blockingEngine, type BlockingEngine } from "./support/blocking-engine.ts";

const quiet = createLogger("test", () => {});
const stopAll: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const stop of stopAll.reverse()) await stop();
  stopAll.length = 0;
});

const job = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "go", maxTurns: 1 },
});

/** A runner holding one Job, with the engine still in the middle of it. */
async function holding(jobId: string): Promise<{ double: ServerDouble; slow: BlockingEngine }> {
  const double = await startServerDouble();
  stopAll.push(() => double.stop());
  const slow = blockingEngine();
  const runner = await startRunner({ url: double.url, engine: slow.engine, log: quiet });
  stopAll.push(() => runner.stop());

  await double.helloReceived();
  await double.assign(job(jobId));
  await slow.running;
  return { double, slow };
}

describe("a cancel for a Job the runner is holding", () => {
  test("stops the engine", async () => {
    const { double, slow } = await holding("job-1");

    // No wait after this: the runner answers from the handler that aborts, so
    // the reply arriving is the abort having happened.
    expect(await double.cancel("job-1", "user_cancelled")).toEqual({ stopped: true, commits: [] });

    expect(slow.state.aborted).toBe(true);
  });

  test("and the run it abandoned never becomes the Job's outcome", async () => {
    const { double } = await holding("job-2");

    await double.cancel("job-2", "lease_expired");
    // The second `runner.ready` is the Job leaving the runner's hands, which is
    // after the only point an outcome could have been sent.
    await double.waitForReady(2);

    // A requeued Job is not `done`, so a completion arriving for it would be
    // applied, and the Run would carry the result of a run that was told to
    // stop. Another runner may already hold it by now.
    expect(double.completionAttempts("job-2")).toBe(0);
  });

  test("frees the slot, so the Job can be picked up again", async () => {
    const { double } = await holding("job-3");

    await double.cancel("job-3", "lease_expired");
    await double.waitForReady(2);

    // The slot goes back with the Job and not before: freeing it early is how a
    // runner took new work while the store still said it held the old one.
    expect(double.readies().at(-1)).toEqual({ slots: 1 });
    expect(await double.assign(job("job-4"))).toEqual({ accepted: true });
  });
});

describe("a cancel for a Job the runner does not hold", () => {
  test("is answered as stopped, because it is", async () => {
    const double = await startServerDouble();
    stopAll.push(() => double.stop());
    const runner = await startRunner({ url: double.url, engine: fakeEngine(), log: quiet });
    stopAll.push(() => runner.stop());
    await double.helloReceived();

    // Not holding it is a success: the server wanted it stopped, and it is.
    // Refusing here would leave the server unable to tell "never had it" from
    // "would not let go".
    expect(await double.cancel("never-assigned", "user_cancelled")).toEqual({
      stopped: true,
      commits: [],
    });
  });

  test("so cancelling the same Job twice is answered twice, not refused", async () => {
    const { double } = await holding("job-5");

    await double.cancel("job-5", "user_cancelled");
    await double.waitForReady(2);

    expect(await double.cancel("job-5", "user_cancelled")).toEqual({
      stopped: true,
      commits: [],
    });
    expect(double.completionAttempts("job-5")).toBe(0);
  });
});
