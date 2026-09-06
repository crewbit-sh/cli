/**
 * Parser for the `--output-format stream-json` line protocol.
 *
 * This is not a stable contract, so it is parsed defensively: anything the
 * parser does not recognise is dropped and the stream keeps going. A shape
 * change upstream should cost fidelity in the transcript, never a crashed Job.
 * The recorded ground truth lives in ../../fixtures.
 *
 * #16: nothing raw leaves this parser any more. A `user` line's tool result
 * and an assistant line's thinking-only block used to fall through to
 * `{ t: "other", raw: message }` - the target repository's own contents,
 * measured at 96% of what a transcript costs to send, store and read - and
 * they carry only their own first 200 characters now, as `tool_result` and
 * `thinking`. Everything else that used to be `other` is dropped rather than
 * kept: an event the server cannot name is not an event. `other` stays on the
 * wire, deprecated, for a runner older than this release.
 */

import type { EngineEvent, EngineResult } from "./types.ts";

export type ParsedLine =
  | { kind: "event"; event: EngineEvent }
  | { kind: "result"; result: EngineResult }
  | { kind: "ignored" };

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** Only on a `thinking` block. */
  thinking?: string;
};

/** A `user` line's own content block: the tool's answer, and whether it failed. */
type ToolResultBlock = {
  type?: string;
  content?: unknown;
  is_error?: boolean;
};

/** How much of a tool result or a thinking block travels. The rest stays on the runner's machine. */
const EVENT_TEXT_MAX = 200;

export function parseLine(line: string): ParsedLine {
  if (!line.trim()) return { kind: "ignored" };

  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "ignored" };
  }

  // The one line item worth naming among everything a stream can carry that
  // the transcript has no use for: it repeats every few seconds and never
  // carries content. Measured on a real Run's last 60 events, 24 of 28
  // opaque lines were exactly this, in a server that keeps a fixed window of
  // events per Run — each one was a real transcript line pushed out to make
  // room for a ping.
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    return { kind: "ignored" };
  }

  switch (message.type) {
    case "assistant": {
      const event = assistantEvent(message);
      return event ? { kind: "event", event } : { kind: "ignored" };
    }
    case "user": {
      const event = toolResultEvent(message);
      return event ? { kind: "event", event } : { kind: "ignored" };
    }
    case "rate_limit_event": {
      const event = rateLimitEvent(message);
      return event ? { kind: "event", event } : { kind: "ignored" };
    }
    case "result":
      return { kind: "result", result: toResult(message) };
    default:
      return { kind: "ignored" };
  }
}

/**
 * Drives a whole stream. Returns null when the engine died before its result,
 * which the caller reports as a failure rather than inventing an outcome.
 */
export async function consumeStream(
  lines: AsyncIterable<string> | Iterable<string>,
  onEvent: (event: EngineEvent) => void,
): Promise<EngineResult | null> {
  let result: EngineResult | null = null;
  for await (const line of lines) {
    const parsed = parseLine(line);
    if (parsed.kind === "event") onEvent(parsed.event);
    else if (parsed.kind === "result") result = parsed.result;
  }
  return result;
}

/** An outcome for the cases where the engine never produced one of its own. */
export function failedResult(text: string, terminalReason: string): EngineResult {
  return {
    ok: false,
    text,
    sessionId: "",
    turns: 0,
    costUsd: 0,
    subtype: "error",
    terminalReason,
  };
}

/**
 * Measured: the CLI sends one content block per assistant message, so text and
 * tool calls arrive separately and taking the first mapped block loses nothing.
 * A thinking block is the fallback: #16 surfaces it only when the message
 * carried nothing else, which "one block per message" makes the common case
 * anyway. Undefined when none of the three shapes matched - dropped rather
 * than kept, the same as everything else this parser does not recognise.
 */
function assistantEvent(message: Record<string, unknown>): EngineEvent | undefined {
  const inner = message.message as { content?: ContentBlock[] } | undefined;
  let thinking: string | undefined;
  for (const block of inner?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      return { t: "assistant", text: block.text };
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const summary = summarise(block.input);
      return summary
        ? { t: "tool_use", name: block.name, summary }
        : { t: "tool_use", name: block.name };
    }
    if (thinking === undefined && block.type === "thinking" && typeof block.thinking === "string") {
      thinking = block.thinking;
    }
  }
  return thinking === undefined ? undefined : { t: "thinking", text: firstChars(thinking) };
}

/**
 * A `user` line's own tool result, #16. The engine's `--print` mode has no
 * other kind of `user` line - there is nobody typing one back - so this is
 * the whole of what this shape means. `content` is either the tool's own
 * string, or the API's array-of-blocks form; either way only the first 200
 * characters travel, and never on their own machine's paths past that.
 */
function toolResultEvent(message: Record<string, unknown>): EngineEvent | undefined {
  const inner = message.message as { content?: ToolResultBlock[] } | undefined;
  for (const block of inner?.content ?? []) {
    if (block.type !== "tool_result") continue;
    const text = toolResultText(block.content);
    if (text === undefined) continue;
    return { t: "tool_result", text: firstChars(text), isError: block.is_error === true };
  }
  return undefined;
}

/** A tool result's own content: a string, or the API's array-of-blocks form. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const found = content.find(
    (block) => block && typeof block === "object" && (block as ContentBlock).type === "text",
  ) as ContentBlock | undefined;
  return typeof found?.text === "string" ? found.text : undefined;
}

function rateLimitEvent(message: Record<string, unknown>): EngineEvent | undefined {
  const info = message.rate_limit_info as
    | { rateLimitType?: unknown; resetsAt?: unknown; status?: unknown }
    | undefined;
  if (typeof info?.rateLimitType === "string" && typeof info.resetsAt === "number") {
    return {
      t: "rate_limit",
      rateLimitType: info.rateLimitType,
      resetsAt: info.resetsAt,
      // What separates "your window resets at four" from "you have been cut
      // off". Optional because the contract is undocumented and this field was
      // only ever observed as `allowed`; a reader has to treat its absence as
      // "unknown" rather than as "fine".
      ...(typeof info.status === "string" ? { status: info.status } : {}),
    };
  }
  return undefined;
}

/** How much of a tool result or a thinking block travels; the rest never leaves the runner. */
function firstChars(text: string): string {
  return text.slice(0, EVENT_TEXT_MAX);
}

/** The final message is flat, not nested under `message`. */
function toResult(message: Record<string, unknown>): EngineResult {
  const subtype = str(message.subtype);
  const terminalReason = str(message.terminal_reason);
  return {
    ok: message.is_error !== true,
    text: str(message.result),
    sessionId: str(message.session_id),
    turns: num(message.num_turns),
    costUsd: num(message.total_cost_usd),
    subtype,
    terminalReason,
    ...(hitCeiling(subtype, terminalReason) ? { ceiling: true } : {}),
    ...(typeof message.api_error_status === "number" && Number.isFinite(message.api_error_status)
      ? { apiErrorStatus: message.api_error_status }
      : {}),
  };
}

/** The documented signal, one subtype per limit. */
const CEILING_SUBTYPES = new Set(["error_max_turns", "error_max_budget_usd"]);

/**
 * The defensive arm, per the engine invariant. `fixtures/stream-api-error.jsonl`
 * is the measured precedent that the CLI does not always agree with the
 * documented table: it carried `subtype: "success"` with `is_error: true` and
 * the real reason in `terminal_reason`. Neither arm has been observed against a
 * real ceiling on this machine.
 */
const CEILING_REASONS = new Set(["max_turns", "max_budget_usd"]);

function hitCeiling(subtype: string, terminalReason: string): boolean {
  return CEILING_SUBTYPES.has(subtype) || CEILING_REASONS.has(terminalReason);
}

const SUMMARY_MAX = 120;

/** Whichever argument identifies the call, so a transcript line reads at a glance. */
function summarise(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["file_path", "path", "command", "pattern", "url", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value) return shorten(value);
  }
  return undefined;
}

/**
 * Keeps both ends. A long value is usually a path or a command, and cutting
 * only the tail throws away the filename, which is the whole reason the
 * summary exists.
 */
function shorten(value: string): string {
  if (value.length <= SUMMARY_MAX) return value;
  const head = Math.ceil((SUMMARY_MAX - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(head - (SUMMARY_MAX - 3))}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
