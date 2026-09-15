/**
 * Parser for `copilot --output-format json`, which is a different protocol
 * wearing the same file extension: JSONL, one `{type, data, id, timestamp,
 * parentId}` per line, and not one field name in common with the stream
 * `stream.ts` reads. That is why this is its own file rather than another arm
 * of that switch - the two share the vocabulary an `EngineEvent` is written in
 * and nothing below it.
 *
 * Parsed defensively for the same reason `stream.ts` is: the shape is not a
 * stable contract, anything unrecognised is dropped, and a change upstream
 * should cost fidelity in the transcript rather than a crashed Job. The
 * recorded ground truth is `fixtures/copilot-ok.jsonl`.
 *
 * Measured, Copilot CLI 1.0.83: one run emits eighteen types, of which three
 * are read here. `assistant.message` carries the text and the tool calls,
 * `session.usage_checkpoint` carries what has been spent, `assistant.turn_start`
 * is the turn count, and the final `result` line - flat, not under `data` -
 * carries the session and the exit code. `tool.execution_complete` is the one
 * dropped line worth naming: it carries a tool's answer, and the protocol has a
 * `tool_result` event for it, but nothing asked for one here and inventing the
 * requirement is not this file's to do.
 */

import { shorten, summarise } from "./stream.ts";
import type { EngineEvent, EngineResult } from "./types.ts";

export type ParsedCopilotLine =
  /** Everything one `assistant.message` produced, in the order it listed them. */
  | { kind: "events"; events: EngineEvent[] }
  /** A spend-so-far checkpoint. Cumulative, so the last one is the bill. */
  | { kind: "usage"; nanoAiu: number }
  /** A turn began. Counted, never shown. */
  | { kind: "turn" }
  | { kind: "final"; sessionId: string; exitCode: number }
  | { kind: "ignored" };

/** A `toolRequests[]` entry, measured whole: nothing here was guessed. */
type ToolRequest = {
  toolCallId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  type?: string;
  /** A sentence written for a human, which is exactly what a summary wants. */
  intentionSummary?: string;
};

/**
 * GitHub bills Copilot in AI credits and never in dollars, and the stream
 * reports them in nano-units. One credit is $0.01, documented on the billing
 * page: 483,736,500 nanoAIU is 0.4837 credits is $0.0048.
 */
const NANO_PER_CREDIT = 1e9;
const USD_PER_CREDIT = 0.01;

/** The exact quotient. Rounding it to a fixed number of places would be inventing a cost. */
export function usdFromNanoAiu(nanoAiu: number): number {
  if (!Number.isFinite(nanoAiu)) return 0;
  return (nanoAiu / NANO_PER_CREDIT) * USD_PER_CREDIT;
}

export function parseCopilotLine(line: string): ParsedCopilotLine {
  if (!line.trim()) return { kind: "ignored" };

  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "ignored" };
  }

  switch (message.type) {
    case "assistant.message": {
      const events = assistantEvents(message.data);
      return events.length ? { kind: "events", events } : { kind: "ignored" };
    }
    case "assistant.turn_start":
      return { kind: "turn" };
    case "session.usage_checkpoint": {
      const spent = (message.data as { totalNanoAiu?: unknown } | undefined)?.totalNanoAiu;
      // Absent is not zero: a checkpoint that named no total says nothing about
      // the spend, and treating it as zero would overwrite the one before it.
      return typeof spent === "number" && Number.isFinite(spent)
        ? { kind: "usage", nanoAiu: spent }
        : { kind: "ignored" };
    }
    case "result":
      return {
        kind: "final",
        sessionId: typeof message.sessionId === "string" ? message.sessionId : "",
        exitCode: typeof message.exitCode === "number" ? message.exitCode : 0,
      };
    default:
      return { kind: "ignored" };
  }
}

/**
 * One line, up to one assistant event and one `tool_use` per tool request.
 *
 * The text is emitted only when there was some. Measured, the message that
 * requests a tool carries `content: ""`, and most messages an agent sends
 * request a tool: an unconditional assistant event would put a blank
 * transcript line in front of nearly every tool call. `stream.ts` drops an
 * assistant line it can make nothing of for the same reason.
 */
function assistantEvents(data: unknown): EngineEvent[] {
  const message = data as { content?: unknown; toolRequests?: ToolRequest[] } | undefined;
  const events: EngineEvent[] = [];

  if (typeof message?.content === "string" && message.content) {
    events.push({ t: "assistant", text: message.content });
  }
  for (const request of message?.toolRequests ?? []) {
    if (typeof request?.name !== "string" || !request.name) continue;
    const summary = summaryOf(request);
    events.push(
      summary
        ? { t: "tool_use", name: request.name, summary }
        : { t: "tool_use", name: request.name },
    );
  }
  return events;
}

/**
 * The sentence Copilot already wrote for a human, and the argument scan
 * `stream.ts` uses as the fallback: `view` names a `path` and `bash` a
 * `command`, which that scan already reads.
 */
function summaryOf(request: ToolRequest): string | undefined {
  if (typeof request.intentionSummary === "string" && request.intentionSummary) {
    return shorten(request.intentionSummary);
  }
  return summarise(request.arguments);
}

/**
 * Drives a whole stream. Null when the engine died before its `result` line,
 * which the caller reports as a failure rather than inventing an outcome - the
 * same contract `consumeStream` has, because `spawn.ts` reads both the same way.
 */
export async function consumeCopilotStream(
  lines: AsyncIterable<string> | Iterable<string>,
  onEvent: (event: EngineEvent) => void,
): Promise<EngineResult | null> {
  let nanoAiu = 0;
  let turns = 0;
  let text = "";
  let final: { sessionId: string; exitCode: number } | undefined;

  for await (const line of lines) {
    const parsed = parseCopilotLine(line);
    if (parsed.kind === "events") {
      for (const event of parsed.events) {
        if (event.t === "assistant") text = event.text;
        onEvent(event);
      }
    } else if (parsed.kind === "usage") nanoAiu = parsed.nanoAiu;
    else if (parsed.kind === "turn") turns += 1;
    else if (parsed.kind === "final") final = parsed;
  }

  if (!final) return null;

  const ok = final.exitCode === 0;
  return {
    ok,
    text,
    sessionId: final.sessionId,
    turns,
    costUsd: usdFromNanoAiu(nanoAiu),
    subtype: ok ? "success" : "error",
    // Read defensively: a non-zero `exitCode` on a `result` line was never
    // measured, so it names the code rather than claiming to know what it meant.
    // No arm of this sets `ceiling`: `--max-ai-credits` is a documented soft cap
    // and nothing was measured about what the stream says when it bites, so a
    // `partial` here would be a guess handed to a Job that failed some other way.
    terminalReason: ok ? "completed" : `exit_${final.exitCode}`,
  };
}
