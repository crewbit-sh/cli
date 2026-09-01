import { describe, expect, test } from "vitest";
import { retryable, stopReason } from "./reason.ts";

/** What an engine that ended cleanly looks like, so each case names its one difference. */
const clean = {
  ok: true,
  subtype: "success",
  terminalReason: "completed",
  turns: 3,
};

describe("an engine that hit the turn ceiling", () => {
  test("is named as the ceiling, with both numbers", () => {
    const reason = stopReason(
      { ok: false, subtype: "error_max_turns", terminalReason: "max_turns", turns: 81 },
      80,
    );

    expect(reason).toContain("turn ceiling");
    expect(reason).toContain("81");
    expect(reason).toContain("80");
  });

  test("is recognised from the turn count when the engine named nothing", () => {
    // The CLI's `terminal_reason` for this case is not measured anywhere in this
    // repo, so the subtype alone cannot be what the diagnosis depends on.
    const reason = stopReason({ ok: false, subtype: "error", terminalReason: "", turns: 81 }, 80);

    expect(reason).toContain("turn ceiling");
    expect(reason).toContain("81");
    expect(reason).toContain("80");
  });
});

describe("an engine that ended cleanly", () => {
  test("says nothing at all", () => {
    expect(stopReason(clean, 80)).toBeUndefined();
  });

  test("says nothing even when it used its last turn", () => {
    // A run that finished on turn 80 of 80 finished. Accusing it of stopping at
    // the ceiling is noise on the ordinary case, which is most cases.
    expect(stopReason({ ...clean, turns: 80 }, 80)).toBeUndefined();
  });

  test("says nothing when it named no reason either", () => {
    expect(stopReason({ ok: true, subtype: "", terminalReason: "", turns: 2 }, 80)).toBeUndefined();
  });
});

describe("an engine that failed for some other reason", () => {
  test("carries the reason it did name, and does not invent the ceiling", () => {
    // The shape recorded in `fixtures/stream-api-error.jsonl`: `subtype:
    // "success"` alongside `is_error: true`, which is why the subtype is not
    // trusted on its own.
    const reason = stopReason(
      { ok: false, subtype: "success", terminalReason: "api_error", turns: 1 },
      80,
    );

    expect(reason).toContain("api_error");
    expect(reason).not.toContain("turn ceiling");
  });

  test("still reports something when the engine named nothing", () => {
    const reason = stopReason({ ok: false, subtype: "", terminalReason: "", turns: 2 }, 80);

    expect(reason).toMatch(/no reason/i);
    expect(reason).toContain("2");
  });
});

/**
 * The shape those five Jobs arrived in: one turn, nothing spent,
 * and a 529 from the API. Each case below names its one difference from it.
 */
const outage = {
  ok: false,
  terminalReason: "api_error",
  apiErrorStatus: 529,
  turns: 1,
  costUsd: 0,
};

describe("an engine that stopped on a busy API", () => {
  test("is worth trying again", () => {
    expect(retryable(outage)).toBe(true);
  });

  test("is still worth trying again when the CLI called the failure a success", () => {
    // `fixtures/stream-api-error.jsonl` carries `subtype: "success"` alongside
    // `is_error: true`, so the predicate must not be reading the subtype.
    const withSubtype = { ...outage, subtype: "success" };

    expect(retryable(withSubtype)).toBe(true);
  });

  test("every 5xx counts, not just the one that was recorded", () => {
    expect(retryable({ ...outage, apiErrorStatus: 500 })).toBe(true);
    expect(retryable({ ...outage, apiErrorStatus: 503 })).toBe(true);
  });
});

describe("an engine that stopped on something waiting cannot fix", () => {
  test("the recorded blocked network is not tried again", () => {
    expect(retryable({ ...outage, apiErrorStatus: 403 })).toBe(false);
  });

  test("a rate limit is not tried again: its window is hours, not seconds", () => {
    expect(retryable({ ...outage, apiErrorStatus: 429 })).toBe(false);
  });

  test("an api_error the engine put no status on is not tried again", () => {
    const { apiErrorStatus: _status, ...unclassified } = outage;

    expect(retryable(unclassified)).toBe(false);
  });

  test("a reason that is not an api_error is not tried again, whatever the status says", () => {
    expect(retryable({ ...outage, terminalReason: "no_result" })).toBe(false);
    expect(retryable({ ...outage, terminalReason: "cancelled" })).toBe(false);
    expect(retryable({ ...outage, terminalReason: "" })).toBe(false);
  });
});

describe("an engine that produced work before it stopped", () => {
  test("is not thrown away and started over", () => {
    expect(retryable({ ...outage, turns: 40, costUsd: 3.2 })).toBe(false);
  });

  test("is not thrown away for having spent anything at all", () => {
    expect(retryable({ ...outage, costUsd: 0.4 })).toBe(false);
  });

  test("but a first turn that cost nothing is a run with nothing to lose", () => {
    expect(retryable({ ...outage, turns: 1, costUsd: 0 })).toBe(true);
  });
});

describe("an engine that ended cleanly", () => {
  test("is never tried again, whatever status is on it", () => {
    expect(retryable({ ...outage, ok: true })).toBe(false);
    expect(retryable({ ...outage, ok: true, apiErrorStatus: 500 })).toBe(false);
  });
});
