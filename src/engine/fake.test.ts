import { describe, expect, test } from "vitest";
import { fakeEngine } from "./fake.ts";
import type { EngineEvent } from "./types.ts";

const run = {
  prompt: "say something",
  cwd: "/tmp",
  maxTurns: 1,
  onEvent: () => {},
};

describe("fakeEngine", () => {
  test("replays a stream without spawning anything", async () => {
    const events: EngineEvent[] = [];
    const engine = fakeEngine();

    const result = await engine.run({ ...run, onEvent: (event) => events.push(event) });

    expect(events).toContainEqual({ t: "assistant", text: "OK" });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("OK");
    expect(result.sessionId).toBe("fake-session");
  });

  test("records what it was asked to do, so a dispatch can be asserted end to end", async () => {
    const engine = fakeEngine();

    await engine.run({ ...run, prompt: "reply with exactly: OK" });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.prompt).toBe("reply with exactly: OK");
  });

  test("replays a caller-supplied stream, including a failing one", async () => {
    const engine = fakeEngine({
      stream: [
        '{"is_error":true,"session_id":"s","subtype":"error","terminal_reason":"api_error","result":"boom","type":"result"}',
      ],
    });

    const result = await engine.run(run);

    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("api_error");
  });

  test("a stream with no result at all still returns a failure", async () => {
    const engine = fakeEngine({ stream: ['{"type":"system","subtype":"init"}'] });

    const result = await engine.run(run);

    expect(result.ok).toBe(false);
    expect(result.terminalReason).toBe("no_result");
  });
});

/** A run that ended on a busy API, which is what a retry has to be able to follow. */
const OVERLOADED = [
  '{"is_error":true,"num_turns":1,"session_id":"s","total_cost_usd":0,"subtype":"success","terminal_reason":"api_error","api_error_status":529,"result":"API Error: 529 Overloaded","type":"result"}',
];
const SUCCEEDED = [
  '{"is_error":false,"num_turns":1,"session_id":"s2","total_cost_usd":0,"subtype":"success","terminal_reason":"completed","result":"second time lucky","type":"result"}',
];

describe("a fakeEngine given a script", () => {
  test("replays a different stream per call, so one engine can fail and then succeed", async () => {
    const engine = fakeEngine({ streams: [OVERLOADED, SUCCEEDED] });

    const first = await engine.run(run);
    const second = await engine.run(run);

    expect(first.ok).toBe(false);
    expect(first.apiErrorStatus).toBe(529);
    expect(second.ok).toBe(true);
    expect(second.text).toBe("second time lucky");
    expect(engine.calls).toHaveLength(2);
  });

  test("keeps replaying its last entry once the script runs out", async () => {
    // Not the default success, and not a throw: a caller writing "fails every
    // time" should not have to know how many times it will be asked.
    const engine = fakeEngine({ streams: [OVERLOADED] });

    await engine.run(run);
    await engine.run(run);
    const third = await engine.run(run);

    expect(third.ok).toBe(false);
    expect(third.apiErrorStatus).toBe(529);
  });
});
