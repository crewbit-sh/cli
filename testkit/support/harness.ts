/**
 * The setup every integration file against the server double repeats: a quiet
 * logger, a stop list `afterEach` drains in reverse, and a `server()` that
 * starts a double and registers its own teardown. Four files carried this
 * verbatim before it moved here.
 */
import { afterEach } from "bun:test";
import { createLogger } from "../../src/index.ts";
import { type ServerDouble, startServerDouble } from "../server-double.ts";

export function integrationHarness(): {
  quiet: ReturnType<typeof createLogger>;
  stopAll: Array<() => void | Promise<void>>;
  server(): Promise<ServerDouble>;
} {
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

  return { quiet, stopAll, server };
}
