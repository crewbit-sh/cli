/**
 * Without a transcript a Job is opaque until it completes, which makes a Stage
 * going wrong indistinguishable from one that is merely slow.
 *
 * What the runner decides is all of it up to the wire: which lines of the
 * engine's stream become which events, what an event it does not recognise
 * turns into, how many of them share a frame and in what order, and that a
 * rate limit is both an event and something a person is told about.
 *
 * Ported from the service's own suite, where the same cases were
 * read back out of the store. They are read off the frames here instead, which
 * is the same claim one layer earlier: that the server keeps what it was sent
 * is the store's to prove.
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

const job = (jobId: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt: "reply with exactly: OK", maxTurns: 1 },
});

/**
 * Runs one Job to completion and hands back what reached the wire. The
 * completion is the seam: it travels on the same socket as the event frames
 * and is sent after the last flush, so anything the Job produced is already
 * here.
 */
async function ran(jobId: string, stream?: string[]): Promise<ServerDouble> {
  const double = await startServerDouble();
  stopAll.push(() => double.stop());
  const runner = await startRunner({
    url: double.url,
    engine: fakeEngine(stream ? { stream } : {}),
    log: quiet,
  });
  stopAll.push(() => runner.stop());

  await double.helloReceived();
  await double.assign(job(jobId));
  await double.completionFor(jobId);
  return double;
}

describe("what the engine said", () => {
  test("reaches the server, and is still there when the Job finishes", async () => {
    const double = await ran("job-1");

    const events = double.events("job-1");
    expect(events.map((e) => e.t)).toContain("assistant");
    expect(events.find((e) => e.t === "assistant")).toMatchObject({ text: "OK" });
  });

  test("keeps the events the server does not understand, whole", async () => {
    const double = await ran("job-2", [
      '{"type":"system","subtype":"init","session_id":"s"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
      '{"is_error":false,"num_turns":1,"session_id":"s","subtype":"success","terminal_reason":"completed","result":"OK","type":"result"}',
    ]);

    // A system message has no place in the protocol's own kinds, so it travels
    // as `other` rather than being dropped on the way out.
    const other = double.events("job-2").find((e) => e.t === "other");
    expect(JSON.stringify(other)).toContain("init");
  });

  test("arrives batched, not one frame per message", async () => {
    const double = await ran("job-3", [
      '{"type":"system","subtype":"init","session_id":"s"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"three"}]}}',
      '{"is_error":false,"num_turns":1,"session_id":"s","subtype":"success","terminal_reason":"completed","result":"done","type":"result"}',
    ]);

    // Four events, one frame: the batch is what went over the wire, and a
    // chatty stage sending one frame each is the waste this exists to avoid.
    const frames = double.batches("job-3");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.events).toHaveLength(4);
    expect(frames[0]?.seq).toBe(1);
  });

  test("orders within a batch, so the transcript reads in the order it happened", async () => {
    const double = await ran("job-4", [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}',
      '{"is_error":false,"num_turns":1,"session_id":"s","subtype":"success","terminal_reason":"completed","result":"x","type":"result"}',
    ]);

    const said = double.events("job-4").flatMap((e) => (e.t === "assistant" ? [e.text] : []));

    expect(said).toEqual(["first", "second"]);
  });
});

describe("a rate limit", () => {
  /** The epoch second the CLI actually emitted in the recorded P0 fixture. */
  const RESETS_AT = 1786168200;
  const limited = [
    `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":${RESETS_AT},"rateLimitType":"five_hour"}}`,
    '{"is_error":false,"num_turns":1,"session_id":"s","subtype":"success","terminal_reason":"completed","result":"OK","type":"result"}',
  ];

  test("is reported as something a person should see, with when it lifts", async () => {
    const double = await ran("job-5", limited);

    // The runner cannot reach a person, having no provider credential, so this
    // is the whole of its part: report the condition and let the server pick
    // the channel.
    const [notice] = double.notifications();
    expect(notice).toMatchObject({ jobId: "job-5", code: "rate_limited", level: "warning" });
    // Seconds on the wire, an ISO instant for a human: the point of the notice
    // is that somebody can read when to come back.
    expect(notice?.resumeAt).toBe(new Date(RESETS_AT * 1000).toISOString());
    expect(notice?.message).toContain("five_hour");
  });

  test("is still an event in the transcript, and not only an escalation", async () => {
    const double = await ran("job-6", limited);

    // Both, from the same event: the escalation is what a person sees, and the
    // transcript is where it can be read next to what caused it.
    expect(double.events("job-6").map((e) => e.t)).toContain("rate_limit");
    expect(double.notifications()).toHaveLength(1);
  });
});
