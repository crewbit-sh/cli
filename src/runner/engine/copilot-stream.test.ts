import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consumeCopilotStream, parseCopilotLine, usdFromNanoAiu } from "./copilot-stream.ts";
import type { EngineEvent } from "./types.ts";

function fixture(name: string): string[] {
  const path = new URL(`../../../fixtures/${name}`, import.meta.url);
  return readFileSync(path, "utf8").split("\n");
}

async function run(lines: string[]) {
  const events: EngineEvent[] = [];
  const result = await consumeCopilotStream(lines, (event) => events.push(event));
  return { events, result };
}

/** The final line's shape, measured: flat, not nested under `data`. */
const resultLine = (exitCode = 0, sessionId = "s-1") =>
  JSON.stringify({ type: "result", sessionId, exitCode, usage: { premiumRequests: 1 } });

const checkpoint = (totalNanoAiu: number) =>
  JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu } });

describe("parseCopilotLine", () => {
  test("a blank line is ignored", () => {
    expect(parseCopilotLine("   ")).toEqual({ kind: "ignored" });
  });

  test("a line that is not JSON is ignored rather than crashing the Job", () => {
    expect(parseCopilotLine("{ half a frame")).toEqual({ kind: "ignored" });
  });

  // The stream carries eighteen types and the transcript wants three of them.
  // A type nobody mapped is dropped, the way `stream.ts` drops one.
  test.each([
    "assistant.tool_call_delta",
    "assistant.message_start",
    "model.call_start",
    "session.mcp_servers_loaded",
    "tool.execution_complete",
    "assistant.idle",
  ])("%s carries nothing the transcript shows, so it is dropped", (type) => {
    expect(parseCopilotLine(JSON.stringify({ type, data: { anything: 1 } }))).toEqual({
      kind: "ignored",
    });
  });

  test("an assistant message that carried text is one assistant event", () => {
    const parsed = parseCopilotLine(
      JSON.stringify({ type: "assistant.message", data: { content: "done", toolRequests: [] } }),
    );

    expect(parsed).toEqual({ kind: "events", events: [{ t: "assistant", text: "done" }] });
  });

  // Measured: the message that requests a tool carries `content: ""`. An
  // assistant event for it would put a blank transcript line in front of
  // every tool call the agent makes.
  test("an assistant message with no text is only its tool calls", () => {
    const parsed = parseCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        data: {
          content: "",
          toolRequests: [
            {
              toolCallId: "c1",
              name: "view",
              arguments: { path: "probe.ts" },
              type: "function",
              intentionSummary: "view the file at probe.ts.",
            },
          ],
        },
      }),
    );

    expect(parsed).toEqual({
      kind: "events",
      events: [{ t: "tool_use", name: "view", summary: "view the file at probe.ts." }],
    });
  });

  test("one tool_use per entry, in the order the message listed them", () => {
    const parsed = parseCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        data: {
          content: "both",
          toolRequests: [
            { name: "view", arguments: { path: "a.ts" }, intentionSummary: "first" },
            { name: "bash", arguments: { command: "ls" }, intentionSummary: "second" },
          ],
        },
      }),
    );
    const events = parsed.kind === "events" ? parsed.events : [];

    expect(events).toEqual([
      { t: "assistant", text: "both" },
      { t: "tool_use", name: "view", summary: "first" },
      { t: "tool_use", name: "bash", summary: "second" },
    ]);
  });

  test("a tool call with no intention summary falls back to the argument that identifies it", () => {
    const parsed = parseCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        data: { content: "", toolRequests: [{ name: "bash", arguments: { command: "ls -la" } }] },
      }),
    );

    expect(parsed).toEqual({
      kind: "events",
      events: [{ t: "tool_use", name: "bash", summary: "ls -la" }],
    });
  });

  test("a tool call the parser can name but not summarise is still a tool_use", () => {
    const parsed = parseCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        data: { content: "", toolRequests: [{ name: "list_bash", arguments: {} }] },
      }),
    );

    expect(parsed).toEqual({ kind: "events", events: [{ t: "tool_use", name: "list_bash" }] });
  });

  test("a long intention summary keeps both ends, the way a Claude one does", () => {
    const long = `view the file at /very/long${"/nested".repeat(30)}/auth.ts`;
    const parsed = parseCopilotLine(
      JSON.stringify({
        type: "assistant.message",
        data: { content: "", toolRequests: [{ name: "view", intentionSummary: long }] },
      }),
    );
    const summary =
      parsed.kind === "events" && parsed.events[0]?.t === "tool_use"
        ? parsed.events[0].summary
        : "";

    expect(summary?.length).toBeLessThanOrEqual(120);
    expect(summary).toMatch(/auth\.ts$/);
  });

  test("an assistant message carrying neither text nor a tool call produces nothing", () => {
    expect(
      parseCopilotLine(JSON.stringify({ type: "assistant.message", data: { content: "" } })),
    ).toEqual({ kind: "ignored" });
  });

  test("a turn start is counted, not shown", () => {
    expect(parseCopilotLine(JSON.stringify({ type: "assistant.turn_start", data: {} }))).toEqual({
      kind: "turn",
    });
  });

  test("a usage checkpoint carries the credits spent so far", () => {
    expect(parseCopilotLine(checkpoint(274608000))).toEqual({ kind: "usage", nanoAiu: 274608000 });
  });

  test("a usage checkpoint with no credit total is ignored rather than counted as zero", () => {
    expect(
      parseCopilotLine(JSON.stringify({ type: "session.usage_checkpoint", data: {} })),
    ).toEqual({ kind: "ignored" });
  });

  test("the result line is flat: its session and exit code are not under data", () => {
    expect(parseCopilotLine(resultLine(0, "56162319"))).toEqual({
      kind: "final",
      sessionId: "56162319",
      exitCode: 0,
    });
  });
});

describe("what a credit costs", () => {
  // GitHub bills AI credits at $0.01 each, and the stream reports nanoAIU.
  test("the Spec's measured run: 483,736,500 nanoAIU is $0.0048", () => {
    expect(usdFromNanoAiu(483736500)).toBeCloseTo(0.0048, 4);
  });

  test("a stream that reported no credits costs 0, not NaN", () => {
    expect(usdFromNanoAiu(0)).toBe(0);
    expect(Number.isNaN(usdFromNanoAiu(0))).toBe(false);
  });
});

describe("consumeCopilotStream", () => {
  test("a stream that never reached its result line is not an outcome", async () => {
    const { result } = await run([
      JSON.stringify({ type: "assistant.message", data: { content: "half" } }),
    ]);

    expect(result).toBeNull();
  });

  test("an empty stream is not an outcome either", async () => {
    expect((await run([])).result).toBeNull();
  });

  test("the last assistant message is the answer, not the first", async () => {
    const { result } = await run([
      JSON.stringify({ type: "assistant.message", data: { content: "thinking" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "the answer" } }),
      resultLine(),
    ]);

    expect(result?.text).toBe("the answer");
  });

  // Measured: the message requesting a tool carries `content: ""` and is often
  // the last one before the answer arrives on the next turn.
  test("an empty last message does not blank the answer the engine gave", async () => {
    const { result } = await run([
      JSON.stringify({ type: "assistant.message", data: { content: "the answer" } }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "", toolRequests: [{ name: "view" }] },
      }),
      resultLine(),
    ]);

    expect(result?.text).toBe("the answer");
  });

  test("the credits are the last checkpoint's total, not the sum of them", async () => {
    // `totalNanoAiu` is cumulative: adding checkpoints up would double-bill.
    const { result } = await run([checkpoint(100000000), checkpoint(300000000), resultLine()]);

    expect(result?.costUsd).toBeCloseTo(0.003, 6);
  });

  test("a stream with no checkpoint reports 0 rather than NaN", async () => {
    const { result } = await run([
      JSON.stringify({ type: "assistant.message", data: { content: "hi" } }),
      resultLine(),
    ]);

    expect(result?.costUsd).toBe(0);
  });

  test("the turns are what the engine said, counted off its turn starts", async () => {
    const { result } = await run([
      JSON.stringify({ type: "assistant.turn_start", data: {} }),
      JSON.stringify({ type: "assistant.turn_start", data: {} }),
      resultLine(),
    ]);

    expect(result?.turns).toBe(2);
  });

  test("exit 0 is a run that finished", async () => {
    const { result } = await run([resultLine(0, "s-9")]);

    expect(result).toMatchObject({
      ok: true,
      sessionId: "s-9",
      subtype: "success",
      terminalReason: "completed",
    });
  });

  test("a non-zero exit is a failure that names the code", async () => {
    const { result } = await run([resultLine(3)]);

    expect(result).toMatchObject({ ok: false, subtype: "error", terminalReason: "exit_3" });
  });

  // #42 removed the turn ceiling, and `--max-ai-credits` is documented as a
  // soft cap with no measured stream signal. Claiming one would hand `partial`
  // to a Job that failed for some other reason.
  test("no run is ever reported as having hit a ceiling", async () => {
    const { result } = await run([checkpoint(999000000000), resultLine(1)]);

    expect(result?.ceiling).toBeUndefined();
  });
});

describe("the recorded run in fixtures/copilot-ok.jsonl", () => {
  test("reports the last assistant message as its text and the result line's session", async () => {
    const { result } = await run(fixture("copilot-ok.jsonl"));

    expect(result?.ok).toBe(true);
    expect(result?.text).toBe("hello from probe");
    expect(result?.sessionId).toBe("56162319-f6d2-42a3-9f42-37e397dc3740");
    expect(result?.turns).toBe(2);
  });

  test("costs what its checkpoint reported, in dollars", async () => {
    const { result } = await run(fixture("copilot-ok.jsonl"));

    // 274,608,000 nanoAIU = 0.274608 credits at $0.01 each.
    expect(result?.costUsd).toBeCloseTo(0.0027, 4);
  });

  test("its transcript is the assistant message and the tool call, and nothing else", async () => {
    const { events } = await run(fixture("copilot-ok.jsonl"));

    expect(events.map((e) => e.t)).toEqual(["tool_use", "assistant"]);
    expect(events[0]).toEqual({
      t: "tool_use",
      name: "view",
      summary: "view the file at /private/tmp/claude-501/copilot-rec/work/probe.ts.",
    });
    expect(events[1]).toEqual({ t: "assistant", text: "hello from probe" });
  });

  // 44 lines, 18 types, 2 of them the transcript shows. The rest are model
  // routing, deltas and MCP status, and none of them reaches the wire.
  test("nothing in it travels as an opaque event", async () => {
    const { events } = await run(fixture("copilot-ok.jsonl"));

    expect(events.some((e) => e.t === "other")).toBe(false);
  });
});
