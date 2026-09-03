/**
 * Parser for the `--output-format stream-json` line protocol.
 *
 * This is not a stable contract, so it is parsed defensively: anything the
 * parser does not recognise becomes an opaque event and the stream keeps going.
 * A shape change upstream should cost fidelity in the transcript, never a
 * crashed Job. The recorded ground truth lives in ../../fixtures.
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
};

export function parseLine(line: string): ParsedLine {
  if (!line.trim()) return { kind: "ignored" };

  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "event", event: { t: "other", raw: line } };
  }

  // The one line item worth naming among everything a stream can carry that
  // the transcript has no use for: it repeats every few seconds and never
  // carries content. Measured on a real Run's last 60 events, 24 of 28
  // opaque lines were exactly this, in a server that keeps a fixed window of
  // events per Run — each one was a real transcript line pushed out to make
  // room for a ping. Everything else still arrives as `other`.
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    return { kind: "ignored" };
  }

  switch (message.type) {
    case "assistant":
      return { kind: "event", event: assistantEvent(message) };
    case "rate_limit_event":
      return { kind: "event", event: rateLimitEvent(message) };
    case "result":
      return { kind: "result", result: toResult(message) };
    default:
      return { kind: "event", event: { t: "other", raw: message } };
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
 * If that ever changes, the extra blocks are dropped rather than mangled, which
 * costs transcript fidelity and nothing else.
 */
function assistantEvent(message: Record<string, unknown>): EngineEvent {
  const inner = message.message as { content?: ContentBlock[] } | undefined;
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
  }
  return { t: "other", raw: message };
}

function rateLimitEvent(message: Record<string, unknown>): EngineEvent {
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
  return { t: "other", raw: message };
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
