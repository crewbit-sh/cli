import { describe, expect, test } from "vitest";
import { createLogger } from "./log.ts";

const captured = () => {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: createLogger("crewbit-runner", (raw) => lines.push(JSON.parse(raw))) };
};

describe("a line the runner writes", () => {
  test("carries the agent's own output through the same format", () => {
    const { log, lines } = captured();

    // What the runner does with an engine event, asserted on the shape a
    // collector receives rather than on the wiring that produces it.
    log.info("I'll start by reading the required inputs.", {
      job_id: "job_1",
      event: "assistant",
    });

    const [assistant] = lines;
    expect(assistant?.status).toBe("info");
    expect(assistant?.service).toBe("crewbit-runner");
    expect(assistant?.job_id).toBe("job_1");
    expect(assistant?.message).toBe("I'll start by reading the required inputs.");
  });

  test("survives a field that cannot be serialised, and says so", () => {
    const { log, lines } = captured();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    log.error("job failed", { job_id: "job_2", cause: cyclic });

    // An unserialisable field must not take a runner down mid-Job, and dropping
    // the line entirely would hide whatever was being reported.
    const [failed] = lines;
    expect(failed?.message).toBe("job failed");
    expect(failed?.status).toBe("error");
    expect(failed?.["log.fields_dropped"]).toBeTruthy();
  });
});
