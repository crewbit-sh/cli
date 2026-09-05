import { describe, expect, test } from "bun:test";
import type { JobEvent } from "@crewbit/protocol";
import { coalesceRateLimits, rateLimitIsSafe, rateLimitMessage } from "./rate-limit.ts";

describe("rateLimitIsSafe", () => {
  test("allowed is safe: the engine kept working", () => {
    expect(rateLimitIsSafe({ rateLimitType: "five_hour", status: "allowed" })).toBe(true);
  });

  test("allowed_warning is safe too", () => {
    expect(rateLimitIsSafe({ rateLimitType: "five_hour", status: "allowed_warning" })).toBe(true);
  });

  test("rejected is not safe", () => {
    expect(rateLimitIsSafe({ rateLimitType: "five_hour", status: "rejected" })).toBe(false);
  });

  test("no status is not safe - absent means unknown, never fine", () => {
    expect(rateLimitIsSafe({ rateLimitType: "five_hour" })).toBe(false);
  });

  test("a status this list does not name is not safe either", () => {
    expect(rateLimitIsSafe({ rateLimitType: "five_hour", status: "something_new" })).toBe(false);
  });
});

describe("rateLimitMessage", () => {
  test("rejected says the window is exhausted, and names the status", () => {
    const message = rateLimitMessage({ rateLimitType: "five_hour", status: "rejected" });
    expect(message).toContain("five_hour");
    expect(message).toContain("exhausted");
    expect(message).toContain("rejected");
  });

  test("no status says the status is unknown, never exhausted", () => {
    const message = rateLimitMessage({ rateLimitType: "five_hour" });
    expect(message).toContain("unknown");
    expect(message).not.toContain("exhausted");
  });

  test("an unrecognised status also says unknown, not exhausted", () => {
    const message = rateLimitMessage({ rateLimitType: "five_hour", status: "something_new" });
    expect(message).toContain("unknown");
    expect(message).not.toContain("exhausted");
  });
});

/** A safe rate_limit event, five_hour unless a test says otherwise. */
function allowed(status: "allowed" | "allowed_warning" = "allowed", resetsAt = 1): JobEvent {
  return { t: "rate_limit", rateLimitType: "five_hour", resetsAt, status };
}

describe("coalesceRateLimits, #11", () => {
  test("a single safe event reaches push on its own, with nothing to close", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));

    rateLimits.push(allowed());
    rateLimits.push({ t: "assistant", text: "done" });

    expect(pushed).toEqual([allowed(), { t: "assistant", text: "done" }]);
  });

  test("a run of safe events reaches push once, and once more with a count when a different event arrives", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));

    rateLimits.push(allowed("allowed", 1));
    rateLimits.push(allowed("allowed_warning", 2));
    rateLimits.push(allowed("allowed_warning", 3));
    rateLimits.push({ t: "assistant", text: "done" });

    expect(pushed).toEqual([
      allowed("allowed", 1),
      { t: "rate_limit", rateLimitType: "five_hour × 3", resetsAt: 3, status: "allowed_warning" },
      { t: "assistant", text: "done" },
    ]);
  });

  test("a dangling run closes on flush, for a Job that ends mid-run", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));

    rateLimits.push(allowed("allowed", 1));
    rateLimits.push(allowed("allowed", 2));
    rateLimits.flush();

    expect(pushed).toEqual([
      allowed("allowed", 1),
      { t: "rate_limit", rateLimitType: "five_hour × 2", resetsAt: 2, status: "allowed" },
    ]);
  });

  test("flush with no open run pushes nothing", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));

    rateLimits.flush();

    expect(pushed).toEqual([]);
  });

  test("a rejected event is never coalesced, and closes a run in progress", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));
    const rejected: JobEvent = {
      t: "rate_limit",
      rateLimitType: "five_hour",
      resetsAt: 9,
      status: "rejected",
    };

    rateLimits.push(allowed("allowed", 1));
    rateLimits.push(allowed("allowed", 2));
    rateLimits.push(rejected);

    expect(pushed).toEqual([
      allowed("allowed", 1),
      { t: "rate_limit", rateLimitType: "five_hour × 2", resetsAt: 2, status: "allowed" },
      rejected,
    ]);
  });

  test("a different rateLimitType starts its own run rather than joining the count", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));
    const weekly: JobEvent = {
      t: "rate_limit",
      rateLimitType: "weekly",
      resetsAt: 5,
      status: "allowed",
    };

    rateLimits.push(allowed("allowed", 1));
    rateLimits.push(allowed("allowed", 2));
    rateLimits.push(weekly);

    expect(pushed).toEqual([
      allowed("allowed", 1),
      { t: "rate_limit", rateLimitType: "five_hour × 2", resetsAt: 2, status: "allowed" },
      weekly,
    ]);
  });

  test("tool_use and other events pass straight through and close a run in progress", () => {
    const pushed: JobEvent[] = [];
    const rateLimits = coalesceRateLimits((event) => pushed.push(event));
    const toolUse: JobEvent = { t: "tool_use", name: "Read" };

    rateLimits.push(allowed("allowed", 1));
    rateLimits.push(allowed("allowed", 2));
    rateLimits.push(toolUse);

    expect(pushed).toEqual([
      allowed("allowed", 1),
      { t: "rate_limit", rateLimitType: "five_hour × 2", resetsAt: 2, status: "allowed" },
      toolUse,
    ]);
  });
});
