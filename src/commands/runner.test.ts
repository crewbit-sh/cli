import { describe, expect, test } from "bun:test";
import type { Logger } from "../log.ts";
import {
  ENGINE_NAMES,
  type EngineFlags,
  type EngineName,
  engineNamed,
  resolveEngineName,
  transcriptLogger,
} from "./runner.ts";

type Line = {
  level: "info" | "warning" | "error";
  message: string;
  fields?: Record<string, unknown>;
};

function recording(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (message, fields) => lines.push({ level: "info", message, fields }),
      warning: (message, fields) => lines.push({ level: "warning", message, fields }),
      error: (message, fields) => lines.push({ level: "error", message, fields }),
    },
  };
}

describe("transcriptLogger", () => {
  test("names an assistant message", () => {
    const { log, lines } = recording();
    transcriptLogger(log)("job-1", { t: "assistant", text: "OK" });

    expect(lines[0]).toMatchObject({ level: "info", message: "OK" });
  });

  test("names a tool call and its summary", () => {
    const { log, lines } = recording();
    transcriptLogger(log)("job-1", { t: "tool_use", name: "Read", summary: "file.ts" });

    expect(lines[0]).toMatchObject({ level: "info", message: "Read file.ts" });
  });

  test("carries a rate limit's status", () => {
    const { log, lines } = recording();
    transcriptLogger(log)("job-1", {
      t: "rate_limit",
      rateLimitType: "five_hour",
      resetsAt: 0,
      status: "allowed_warning",
    });

    expect(lines[0]?.fields?.status).toBe("allowed_warning");
  });

  test("names no status when the engine gave none", () => {
    const { log, lines } = recording();
    transcriptLogger(log)("job-1", { t: "rate_limit", rateLimitType: "five_hour", resetsAt: 0 });

    expect(lines[0]?.fields?.status).toBeUndefined();
  });
});

/**
 * The whole point of splitting this out of `runRunner`: every row below is an
 * argv shape, and reaching any of them needs no socket, no engine and no
 * process. `--engine` is consulted first and `--fake` only when it is absent,
 * so a script written against 0.12.0 keeps working and an explicit name always
 * wins.
 */
describe("resolveEngineName", () => {
  const RESOLVED: Array<{ name: string; values: EngineFlags; expected: EngineName }> = [
    { name: "no flags at all is the default engine", values: {}, expected: "claude-cli" },
    {
      name: "the default named explicitly is the default",
      values: { engine: "claude-cli" },
      expected: "claude-cli",
    },
    { name: "the recording named explicitly", values: { engine: "fake" }, expected: "fake" },
    { name: "`--fake` alone is still the recording", values: { fake: true }, expected: "fake" },
    {
      name: "`--engine` wins over `--fake` when they disagree",
      values: { fake: true, engine: "claude-cli" },
      expected: "claude-cli",
    },
    {
      name: "agreeing is not a special case",
      values: { fake: true, engine: "fake" },
      expected: "fake",
    },
  ];

  test.each(RESOLVED)("$name", ({ values, expected }) => {
    expect(resolveEngineName(values)).toEqual({ ok: true, value: expected });
  });

  const REFUSED: Array<{ name: string; values: EngineFlags; carries: string }> = [
    {
      name: "a name nobody offers is refused, and named back",
      values: { engine: "wibble" },
      carries: "wibble",
    },
    {
      name: "`--fake` does not rescue a name nobody offers",
      values: { engine: "wibble", fake: true },
      carries: "wibble",
    },
    {
      name: "`--engine=` with nothing after it is refused rather than defaulted",
      values: { engine: "" },
      carries: "--engine",
    },
    {
      name: "one spelling per engine: the name is the kind that goes on the wire",
      values: { engine: "Claude-CLI" },
      carries: "Claude-CLI",
    },
  ];

  test.each(REFUSED)("$name", ({ values, carries }) => {
    const resolved = resolveEngineName(values);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain(carries);
    // Built from the list rather than written out, so a third engine appears
    // here without anyone remembering to update a sentence.
    for (const name of ENGINE_NAMES) expect(resolved.message).toContain(name);
  });
});

describe("engineNamed", () => {
  test.each([...ENGINE_NAMES])("%s builds the engine that reports that kind", (name) => {
    // The name an operator types is the `kind` the handshake sends, and
    // building either one spawns nothing.
    expect(engineNamed(name).kind).toBe(name);
  });
});
