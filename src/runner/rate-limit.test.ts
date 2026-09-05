import { describe, expect, test } from "bun:test";
import { rateLimitIsSafe, rateLimitMessage } from "./rate-limit.ts";

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
