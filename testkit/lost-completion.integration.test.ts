/**
 * A Job that finished, against a double that refuses to take the answer:
 * the runner's own half of a defect measured twice against a real server,
 * before the extraction. Three commits pushed, the project's own
 * suite green, and then one `job.complete` the store could not write. From
 * the Run's point of view none of it happened, so what the
 * runner does about that is the whole of what these tests are about; the
 * server's own idempotency (a retried completion applied exactly once) stays
 * with the server that owns the store.
 *
 * Ported from the service's own suite.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createLogger, fakeEngine, startRunner } from "../src/index.ts";
import { type ServerDouble, startServerDouble } from "./server-double.ts";
import { recordingLog } from "./support/recording-log.ts";

const stopAll: Array<() => void | Promise<void>> = [];
/** Workspaces a test deliberately left on disk, which is the thing under test. */
const kept: string[] = [];

afterEach(async () => {
  for (const stop of stopAll.reverse()) await stop();
  stopAll.length = 0;
  for (const path of kept) await rm(path, { recursive: true, force: true });
  kept.length = 0;
});

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
  harness: { prompt: "reply with exactly: OK", maxTurns: 40 },
});

describe("a completion the server refused once", () => {
  test("is offered again, until it is taken", async () => {
    const double = await server();
    double.refuseCompletion("job-1", 1);
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine(),
      completionRetryMs: 5,
      log: createLogger("crewbit-runner", () => {}),
    });
    stopAll.push(() => runner.stop());

    await double.helloReceived();
    await double.assign(job("job-1"));

    expect((await double.completionFor("job-1")).outcome).toBe("complete");
    // One refused, one that landed.
    expect(double.completionAttempts("job-1")).toBe(2);
  });

  test("leaves nothing behind once it is taken", async () => {
    const double = await server();
    double.refuseCompletion("job-2", 1);
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine(),
      completionRetryMs: 5,
      log: seen.log,
    });
    stopAll.push(() => runner.stop());

    // Registered before the Job, or the line has already been written by the
    // time anything here asks for it.
    const ready = seen.line("workspace ready");
    await double.helloReceived();
    await double.assign(job("job-2"));
    const path = String((await ready).path);

    await double.completionFor("job-2");
    // The seam for the deletion, which logs nothing: draining settles once
    // the runner holds no Job, and it stops holding one only after the
    // workspace is gone. Waiting on the completion alone would race the two.
    await runner.stop({ drain: true });

    expect(existsSync(path)).toBe(false);
  });
});

describe("a completion nobody ever takes", () => {
  test("keeps the workspace, and says where the work was left", async () => {
    const double = await server();
    double.refuseCompletion("job-3", "always");
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine(),
      completionRetryMs: 5,
      completionPatienceMs: 30,
      log: seen.log,
    });
    stopAll.push(() => runner.stop());

    const abandoned = seen.line("the workspace was kept, because nothing recorded the work in it");
    await double.helloReceived();
    await double.assign(job("job-3"));
    const path = String((await abandoned).path);
    kept.push(path);

    // The artifacts of a stage nobody recorded are here or nowhere.
    expect(existsSync(path)).toBe(true);
  });
});

describe("a runner stopped while an outcome is still in hand", () => {
  test("ends there instead of waiting out a retry it can no longer use", async () => {
    const double = await server();
    double.refuseCompletion("job-4", "always");
    const seen = recordingLog();
    const runner = await startRunner({
      url: double.url,
      engine: fakeEngine(),
      // Long enough that passing is the proof: what is under test is the wait
      // between attempts being cleared on stop rather than left to fire,
      // without which this would only pass a minute later.
      completionRetryMs: 60_000,
      log: seen.log,
    });

    const lost = seen.line("completion was not acknowledged");
    await double.helloReceived();
    await double.assign(job("job-4"));
    await lost;

    const abandoned = seen.line("the workspace was kept, because nothing recorded the work in it");
    await runner.stop();
    const path = String((await abandoned).path);
    kept.push(path);

    // Stopped is not the same as taken back: nothing recorded this, and there
    // is no other copy of it.
    expect(existsSync(path)).toBe(true);
  });
});
