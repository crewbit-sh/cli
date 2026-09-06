import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consumeStream, failedResult, parseLine } from "./stream.ts";
import type { EngineEvent, EngineResult } from "./types.ts";

function fixture(name: string): string[] {
  const path = new URL(`../../../fixtures/${name}`, import.meta.url);
  return readFileSync(path, "utf8").split("\n");
}

async function run(lines: string[]) {
  const events: EngineEvent[] = [];
  const result = await consumeStream(lines, (event) => events.push(event));
  return { events, result };
}

describe("parseLine", () => {
  test("an unknown message type is ignored rather than kept as an opaque event", () => {
    const parsed = parseLine(JSON.stringify({ type: "future_thing", payload: 1 }));

    expect(parsed).toEqual({ kind: "ignored" });
  });

  test("a line that is not JSON is ignored rather than kept as an opaque event", () => {
    const parsed = parseLine("{ half a frame");

    expect(parsed.kind).toBe("ignored");
  });

  test("a blank line is ignored", () => {
    expect(parseLine("   ").kind).toBe("ignored");
  });

  test("a thinking-tokens ping is ignored", () => {
    // Measured on a real Run's last 60 events: 24 of 28 opaque lines were
    // exactly this, and it carries nothing a transcript could show. The server
    // keeps a fixed window of events per Run, so every one of these was a real
    // line of the transcript it pushed out to make room.
    const parsed = parseLine(JSON.stringify({ type: "system", subtype: "thinking_tokens" }));

    expect(parsed.kind).toBe("ignored");
  });

  // #16: a system line of an unknown subtype produces no event, and nothing
  // produced by the mapper carries raw - measured at 920 of 1,810 events over
  // seven days, 3.8 MB of a 3.95 MB log, most of it the target repository's
  // own contents.
  test("a system message that is not the ping produces no event, and nothing produced by the mapper carries raw", () => {
    const parsed = parseLine(JSON.stringify({ type: "system", subtype: "init" }));

    expect(parsed).toEqual({ kind: "ignored" });
    expect(JSON.stringify(parsed)).not.toContain("raw");
  });

  test("a long summary keeps both ends, because the filename is at the far one", () => {
    const path = `/very/long/prefix${"/nested".repeat(30)}/auth.ts`;
    const parsed = parseLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] },
      }),
    );
    const summary =
      parsed.kind === "event" && parsed.event.t === "tool_use" ? parsed.event.summary : "";

    expect(summary).toMatch(/^\/very\/long\/prefix/);
    expect(summary).toMatch(/auth\.ts$/);
    expect(summary?.length).toBeLessThanOrEqual(120);
  });

  test("a tool_use block is summarised by the argument that identifies it", () => {
    const parsed = parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } }],
        },
      }),
    );

    expect(parsed).toEqual({
      kind: "event",
      event: { t: "tool_use", name: "Edit", summary: "src/auth.ts" },
    });
  });
});

/**
 * #16: what used to leave as `{ t: "other", raw: message }` - the file the
 * engine read, the test output, the diff - is 96% of what a transcript costs
 * to send, store and read, and it is the target repository's own contents.
 * Only the first 200 characters travel now, and `isError` is what diagnosed
 * crewbit-v2#271.
 */
describe("a user line carrying a tool result", () => {
  const userLine = (content: unknown, isError?: boolean) =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_1",
            type: "tool_result",
            content,
            ...(isError === undefined ? {} : { is_error: isError }),
          },
        ],
      },
    });

  test("produces tool_result with the first 200 characters and isError false", () => {
    const parsed = parseLine(userLine("1\thello from the probe\n2\t"));

    expect(parsed).toEqual({
      kind: "event",
      event: { t: "tool_result", text: "1\thello from the probe\n2\t", isError: false },
    });
  });

  test("is_error: true sets isError", () => {
    const parsed = parseLine(userLine("boom: no such file", true));

    expect(parsed).toEqual({
      kind: "event",
      event: { t: "tool_result", text: "boom: no such file", isError: true },
    });
  });

  test("cuts the text at 200 characters", () => {
    const parsed = parseLine(userLine("x".repeat(500)));
    const text =
      parsed.kind === "event" && parsed.event.t === "tool_result" ? parsed.event.text : "";

    expect(text).toBe("x".repeat(200));
  });

  test("reads the array-of-blocks content form too, not only a plain string", () => {
    const parsed = parseLine(userLine([{ type: "text", text: "from an array block" }]));

    expect(parsed).toEqual({
      kind: "event",
      event: { t: "tool_result", text: "from an array block", isError: false },
    });
  });

  test("a user line with no tool_result block produces no event", () => {
    const parsed = parseLine(
      JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
    );

    expect(parsed).toEqual({ kind: "ignored" });
  });
});

describe("an assistant line with only a thinking block", () => {
  const thinkingLine = (thinking: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking }] } });

  test("produces thinking with the first 200 characters", () => {
    const parsed = parseLine(thinkingLine("the test needs a fixed clock"));

    expect(parsed).toEqual({
      kind: "event",
      event: { t: "thinking", text: "the test needs a fixed clock" },
    });
  });

  test("cuts the text at 200 characters", () => {
    const parsed = parseLine(thinkingLine("y".repeat(500)));

    expect(parsed).toEqual({ kind: "event", event: { t: "thinking", text: "y".repeat(200) } });
  });

  test("is not surfaced when text is also present in the same line", () => {
    const parsed = parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "reasoning about it" },
            { type: "text", text: "the answer" },
          ],
        },
      }),
    );

    expect(parsed).toEqual({ kind: "event", event: { t: "assistant", text: "the answer" } });
  });
});

describe("consumeStream, on a recorded successful run", () => {
  test("yields the assistant text and the rate limit as events", async () => {
    const { events } = await run(fixture("stream-ok.jsonl"));

    expect(events).toContainEqual({ t: "assistant", text: "OK" });
    expect(events).toContainEqual({
      t: "rate_limit",
      rateLimitType: "five_hour",
      resetsAt: 1786168200,
      // Without it these messages all read alike, and "the window resets at
      // four" cannot be told from "you have been cut off". The MLP graduates on
      // rate-limit hits being near zero, and that number is uncountable when
      // every event looks like a hit.
      status: "allowed",
    });
  });

  test("a rate limit event with no status is still an event, not a throw", () => {
    const parsed = parseLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { resetsAt: 1786168200, rateLimitType: "five_hour" },
      }),
    );

    // Undocumented contract, so the field is read where it is and its absence
    // costs nothing. The value it takes when the limit is actually hit was
    // never observed.
    expect(parsed).toEqual({
      kind: "event",
      event: { t: "rate_limit", rateLimitType: "five_hour", resetsAt: 1786168200 },
    });
  });

  test("a status that is not a string is dropped rather than passed on", () => {
    const parsed = parseLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { resetsAt: 1, rateLimitType: "five_hour", status: { nested: true } },
      }),
    );

    expect(parsed).toEqual({
      kind: "event",
      event: { t: "rate_limit", rateLimitType: "five_hour", resetsAt: 1 },
    });
  });

  // #16: the three system lines this fixture carries (two hooks and init) used
  // to survive as opaque events; now none of them does.
  test("drops every system message rather than keeping it as an opaque event", async () => {
    const { events } = await run(fixture("stream-ok.jsonl"));

    expect(events).toEqual([
      { t: "assistant", text: "OK" },
      { t: "rate_limit", rateLimitType: "five_hour", resetsAt: 1786168200, status: "allowed" },
    ]);
  });

  test("yields a result carrying what the server bills and resumes on", async () => {
    const { result } = await run(fixture("stream-ok.jsonl"));

    expect(result).toEqual({
      ok: true,
      text: "OK",
      sessionId: "648b37f4-6813-4902-bdc2-45bc53710210",
      turns: 1,
      costUsd: 0.33401000000000003,
      subtype: "success",
      terminalReason: "completed",
    });
  });
});

describe("consumeStream, on a recorded run that used a tool", () => {
  test("reads as a transcript: what it said, what it ran, what it found, what it concluded", async () => {
    const { events, result } = await run(fixture("stream-tools.jsonl"));
    const spoken = events.filter((e) => e.t !== "rate_limit");

    expect(spoken).toEqual([
      { t: "assistant", text: "I'll read the file." },
      { t: "tool_use", name: "Read", summary: expect.stringContaining("probe.txt") },
      { t: "tool_result", text: "1\thello from the probe\n2\t", isError: false },
      { t: "assistant", text: "It says: `hello from the probe`" },
    ]);
    expect(result?.turns).toBe(2);
  });
});

describe("consumeStream, on a recorded failed run", () => {
  test("reports the failure without throwing", async () => {
    const { result } = await run(fixture("stream-api-error.jsonl"));

    expect(result?.ok).toBe(false);
    expect(result?.terminalReason).toBe("api_error");
    expect(result?.text).toContain("403");
  });

  test("carries the status the API answered with, which is what tells a 403 from a 529", async () => {
    const { result } = await run(fixture("stream-api-error.jsonl"));

    expect(result?.apiErrorStatus).toBe(403);
  });
});

/**
 * The field a retry decision is made from, so its absence must be absence and
 * not a number somebody invented.
 */
describe("api_error_status on the result line", () => {
  const parsed = (fields: Record<string, unknown>): EngineResult | undefined => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      num_turns: 1,
      session_id: "s",
      total_cost_usd: 0,
      subtype: "success",
      terminal_reason: "api_error",
      result: "API Error: 529 Overloaded",
      ...fields,
    });
    const p = parseLine(line);
    return p.kind === "result" ? p.result : undefined;
  };

  test("a numeric status is read", () => {
    expect(parsed({ api_error_status: 529 })?.apiErrorStatus).toBe(529);
  });

  test("a status the CLI never sent leaves the key off entirely", () => {
    expect(parsed({})).not.toHaveProperty("apiErrorStatus");
  });

  test("a status that is a string is dropped rather than passed on as one", () => {
    expect(parsed({ api_error_status: "529" })).not.toHaveProperty("apiErrorStatus");
  });
});

describe("consumeStream, on a truncated stream", () => {
  test("returns null when the engine died before its result", async () => {
    const { result } = await run(fixture("stream-ok.jsonl").slice(0, 4));

    expect(result).toBeNull();
  });
});

/**
 * The ceiling is what makes a Job `partial` rather than `failed`, so it has to
 * be told apart from every other reason a run ends without an answer. The lines
 * here are shaped like the recorded fixtures, minus the fields nothing reads.
 */
describe("a run that stopped at a ceiling", () => {
  const resultLine = (fields: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      num_turns: 80,
      session_id: "s",
      total_cost_usd: 1,
      result: "",
      ...fields,
    });

  const parsed = (line: string): EngineResult | undefined => {
    const p = parseLine(line);
    return p.kind === "result" ? p.result : undefined;
  };

  test("the documented turn ceiling is a ceiling, and not ok", () => {
    const result = parsed(resultLine({ is_error: true, subtype: "error_max_turns" }));

    expect(result?.ok).toBe(false);
    expect(result?.ceiling).toBe(true);
  });

  test("the budget ceiling is a ceiling too", () => {
    const result = parsed(resultLine({ is_error: true, subtype: "error_max_budget_usd" }));

    expect(result?.ceiling).toBe(true);
  });

  test("a CLI that reports the limit only in terminal_reason is still read as one", () => {
    // The defensive arm. `stream-api-error.jsonl` is the measured precedent: the
    // CLI sent `subtype: "success"` with the real reason in `terminal_reason`.
    const result = parsed(
      resultLine({ is_error: true, subtype: "success", terminal_reason: "max_turns" }),
    );

    expect(result?.ceiling).toBe(true);
  });

  test("a budget limit reported only in terminal_reason is read as one as well", () => {
    const result = parsed(
      resultLine({ is_error: true, subtype: "success", terminal_reason: "max_budget_usd" }),
    );

    expect(result?.ceiling).toBe(true);
  });
});

describe("a run that stopped for any other reason", () => {
  test("the recorded 403 is a failure and not a ceiling", async () => {
    const { result } = await run(fixture("stream-api-error.jsonl"));

    expect(result?.ok).toBe(false);
    expect(result?.ceiling).not.toBe(true);
  });

  test("the recorded successful run is not a ceiling", async () => {
    const { result } = await run(fixture("stream-ok.jsonl"));

    expect(result?.ceiling).not.toBe(true);
  });

  test("an engine that died before its result is not a ceiling", () => {
    expect(failedResult("the engine produced no result", "no_result").ceiling).not.toBe(true);
  });

  test("an engine that was killed is not a ceiling", () => {
    expect(failedResult("cancelled", "cancelled").ceiling).not.toBe(true);
  });
});
