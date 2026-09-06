/**
 * #14: the runner drops `--resume` entirely and stops reading a Job's
 * `resumeSessionId`, whatever the server sends.
 *
 * The workspace is always new (`mkdtemp`), so a resumed conversation pointed
 * at paths that were already deleted and carried every turn of every earlier
 * attempt with it: one session read 61 workspaces since the prior night, and
 * three resumed sessions burned a whole five-hour window in 21 minutes with
 * none of their Runs finishing.
 *
 * The wire field stays optional - `@crewbit/protocol` drops it in its own
 * change - so an older server can still send it. What changes here is that
 * the runner never acts on it again, on the first attempt or on a retry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createLogger, fakeEngine, startRunner } from "../src/index.ts";
import { type ServerDouble, startServerDouble } from "./server-double.ts";

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

const OLD_SESSION = "a-session-from-a-workspace-long-since-deleted";

const jobWithResume = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "reply with exactly: OK", maxTurns: 40 },
  resumeSessionId: OLD_SESSION,
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

/** So a retry is exercised: the same transient failure `engine-retry` uses. */
const OVERLOADED = [
  resultLine({
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 529,
    result: "API Error: 529 Overloaded. This is a server-side issue, usually temporary",
  }),
];
const OK = [resultLine({ is_error: false, terminal_reason: "completed", result: "OK" })];

describe("a Job carrying resumeSessionId", () => {
  test("spawns the engine without --resume", async () => {
    const double = await server();
    const engine = fakeEngine({ stream: OK });
    const runner = await startRunner({ url: double.url, engine, log: quiet });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(jobWithResume("job-1"));
    await double.completionFor("job-1");

    expect(engine.calls).toHaveLength(1);
    // The session id the server sent never reaches the engine at all - not
    // as a resume instruction, not anywhere on what it was handed.
    expect(JSON.stringify(engine.calls[0])).not.toContain(OLD_SESSION);
  });

  test("the second engine attempt starts a new session, not the first attempt's", async () => {
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
    await double.assign(jobWithResume("job-2"));
    await double.completionFor("job-2");

    expect(engine.calls).toHaveLength(2);
    for (const call of engine.calls) {
      expect(JSON.stringify(call)).not.toContain(OLD_SESSION);
    }
  });
});
