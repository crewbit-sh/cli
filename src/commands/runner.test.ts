import { describe, expect, test } from "bun:test";
import type { Logger } from "../log.ts";
import { transcriptLogger } from "./runner.ts";

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
