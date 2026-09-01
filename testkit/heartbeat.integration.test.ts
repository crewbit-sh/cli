/**
 * "I am still here", and nothing else.
 *
 * Liveness used to be the WebSocket protocol's own ping, which `Bun.serve`
 * answered without either side writing code. A server that cannot ping leaves
 * the runner's own frames as the only proof a socket is alive, and sending one
 * became the runner's job.
 *
 * The runner half of a pair the service's own suite holds. Deciding that a
 * runner has gone quiet for long enough to take its Jobs back is the server's,
 * and it stays there with the socket that greets and then says nothing.
 */
import { afterEach, describe, expect, test } from "vitest";
import { createLogger, fakeEngine, startRunner } from "../src/index.ts";
import { startServerDouble } from "./server-double.ts";

const quiet = createLogger("test", () => {});
const stopAll: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const stop of stopAll.reverse()) await stop();
  stopAll.length = 0;
});

/**
 * Real time, and deliberate: this file is about an interval, so a wait with a
 * number in it is the subject rather than scaffolding. It is four times the
 * announced beat below, which is what makes the absence it proves mean
 * something.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

async function idleRunnerAgainst(heartbeatSeconds?: number) {
  const double = await startServerDouble(
    heartbeatSeconds === undefined ? {} : { heartbeatSeconds },
  );
  stopAll.push(() => double.stop());
  const runner = await startRunner({ url: double.url, engine: fakeEngine(), log: quiet });
  stopAll.push(() => runner.stop());
  await double.helloReceived();
  return double;
}

describe("a runner holding nothing", () => {
  test("beats, so a server that cannot ping still hears from it", async () => {
    // A tenth of a second, so several beats pass while a test waits.
    const double = await idleRunnerAgainst(0.1);

    // Three, not one: one beat is a runner that announced itself, and what the
    // server reads liveness from is that they keep coming.
    await double.waitForAlive(3);
    expect(double.aliveCount()).toBeGreaterThanOrEqual(3);
  });

  test("beats on the interval the handshake announced, not one of its own", async () => {
    const double = await idleRunnerAgainst();

    await settle();

    // The default this double announces is 30 seconds, so a runner reading the
    // handshake has sent nothing yet. A runner beating on a number of its own
    // is what this catches, and the case above alone would pass for one.
    expect(double.aliveCount()).toBe(0);
  });
});
