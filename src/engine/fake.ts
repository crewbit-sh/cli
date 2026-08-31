import { consumeStream, failedResult } from "./stream.ts";
import type { Engine, EngineRun } from "./types.ts";

/** A successful one-turn run. Inline rather than read from disk, so it works inside a compiled binary. */
const DEFAULT_STREAM = [
  '{"type":"system","subtype":"init","session_id":"fake-session","model":"fake"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
  '{"is_error":false,"num_turns":1,"session_id":"fake-session","total_cost_usd":0,"subtype":"success","terminal_reason":"completed","result":"OK","type":"result"}',
];

export type FakeEngine = Engine & { calls: EngineRun[] };

/**
 * Replays a recorded stream through the real parser. No process, no tokens, no
 * network: this is what makes the runner testable in CI without spending
 * real tokens.
 *
 * `streams` is a script, one entry per call, and the last entry repeats once
 * the script runs out: a caller saying "fails every time" must not have to know
 * how many attempts it will be asked for. Without it one stream answered every
 * call, so "fails, then succeeds" was inexpressible and no retry could be
 * tested through this engine.
 */
export function fakeEngine(options: { stream?: string[]; streams?: string[][] } = {}): FakeEngine {
  const script = options.streams?.length ? options.streams : [options.stream ?? DEFAULT_STREAM];
  const calls: EngineRun[] = [];

  return {
    kind: "fake",
    version: "0",
    calls,
    async run(run) {
      const stream = script[Math.min(calls.length, script.length - 1)] as string[];
      calls.push(run);
      const result = await consumeStream(stream, run.onEvent);
      return result ?? failedResult("the fake stream carried no result", "no_result");
    },
  };
}
