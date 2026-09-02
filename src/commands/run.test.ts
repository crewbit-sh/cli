import { describe, expect, test } from "bun:test";
import { type Fetch, fetchRun, type RunProjection, renderAiAgent } from "./run.ts";

const answering =
  (body: unknown, ok = true, status = 200): Fetch =>
  async () =>
    ({ ok, status, statusText: "", json: async () => body, text: async () => "" }) as Response;

describe("reading one Run off the server", () => {
  test("asks the right path with the credential as a bearer token", async () => {
    const asked: Array<{ url: string; headers: unknown }> = [];
    const get: Fetch = async (url, init) => {
      asked.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ run: {} }) } as Response;
    };

    await fetchRun("https://app.crewbit.sh", "run_1", "crw_abc", { get });

    expect(asked).toEqual([
      {
        url: "https://app.crewbit.sh/api/runs/run_1",
        headers: { authorization: "Bearer crw_abc" },
      },
    ]);
  });

  test("a trailing slash on the server does not double up", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({}) } as Response;
    };

    await fetchRun("https://app.crewbit.sh/", "run_1", "crw_abc", { get });

    expect(asked).toEqual(["https://app.crewbit.sh/api/runs/run_1"]);
  });

  test("asks for no events at all when none is asked for", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({}) } as Response;
    };

    await fetchRun("s", "r", "t", { get });

    expect(asked).toEqual(["s/api/runs/r"]);
  });

  test("--events becomes ?limit= on the request", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({}) } as Response;
    };

    await fetchRun("s", "r", "t", { events: 50, get });

    expect(asked).toEqual(["s/api/runs/r?limit=50"]);
  });

  test("carries the body back on success", async () => {
    const result = await fetchRun("s", "r", "t", { get: answering({ run: { id: "r" } }) });

    expect(result).toEqual({ ok: true, body: { run: { id: "r" } } });
  });

  test("a refusal carries the status and what the server said", async () => {
    const get: Fetch = async () =>
      ({ ok: false, status: 404, statusText: "", text: async () => "no such run" }) as Response;

    const result = await fetchRun("s", "r", "t", { get });

    expect(result).toEqual({ ok: false, status: 404, reason: "no such run" });
  });
});

const AT = "2026-08-24T12:00:00Z";
const HOUR = 3_600_000;

function projection(over: Partial<RunProjection["run"]> = {}): RunProjection {
  return {
    run: {
      id: "run_1",
      state: "in_review",
      title: "say what a Job is doing",
      source: "acme/api",
      externalKey: "6",
      provider: "github",
      reviewUrl: "https://github.com/acme/api/pull/9",
      updatedAt: AT,
      costUsd: 1.2345,
      jobState: null,
      jobStage: null,
      jobRunner: null,
      lastStage: "eval",
      lastTurns: 12,
      lastTurnsMax: 40,
      ...over,
    },
    transitions: [{ from: "evaluating", to: "in_review", cause: "system", at: AT }],
    events: { lines: [], total: 0 },
  };
}

describe("the ai_agent rendering", () => {
  test("says how long the Run has been in its current state", () => {
    const rendered = renderAiAgent(projection(), new Date(Date.parse(AT) + 34 * HOUR));

    expect(rendered).toContain("State: in_review (34h since it got here)");
  });

  test("falls back to updatedAt when there is no transition yet", () => {
    const empty = projection();
    empty.transitions = [];

    const rendered = renderAiAgent(empty, new Date(Date.parse(AT) + 5 * 60_000));

    expect(rendered).toContain("State: in_review (5m since it got here)");
  });

  test("carries the review's own url, so a human can check the other side", () => {
    const rendered = renderAiAgent(projection());

    expect(rendered).toContain("https://github.com/acme/api/pull/9");
  });

  test("says plainly when no review has opened yet", () => {
    const rendered = renderAiAgent(projection({ reviewUrl: null }));

    expect(rendered).toContain("Review: none opened yet");
  });

  test("summarises an event by what the engine reported, not the raw payload", () => {
    const withEvents = projection();
    withEvents.events = {
      total: 2,
      lines: [
        {
          kind: "assistant",
          stage: "code",
          createdAt: AT,
          payload: JSON.stringify({ t: "assistant", text: "reading the failing test" }),
        },
        {
          kind: "tool_use",
          stage: "code",
          createdAt: AT,
          payload: JSON.stringify({ t: "tool_use", name: "Edit", summary: "src/foo.ts" }),
        },
      ],
    };

    const rendered = renderAiAgent(withEvents);

    expect(rendered).toContain("reading the failing test");
    expect(rendered).toContain("Edit src/foo.ts");
  });

  test("a payload that is not JSON falls back to its kind rather than throwing", () => {
    const withEvents = projection();
    withEvents.events = {
      total: 1,
      lines: [{ kind: "other", stage: "code", createdAt: AT, payload: "not json" }],
    };

    expect(() => renderAiAgent(withEvents)).not.toThrow();
    expect(renderAiAgent(withEvents)).toContain("other");
  });

  test("says the total when events were capped, not just what came back", () => {
    const withEvents = projection();
    withEvents.events = { total: 205, lines: [] };

    const rendered = renderAiAgent(withEvents);

    expect(rendered).toContain("Events (0 of 205, newest first)");
  });

  test("points at --events when events exist but none were fetched", () => {
    const withEvents = projection();
    withEvents.events = { total: 205, lines: [] };

    const rendered = renderAiAgent(withEvents);

    expect(rendered).toContain("205 recorded, none fetched. Pass --events <n> to read them.");
  });

  test("says none recorded, not the --events hint, when there truly are none", () => {
    const rendered = renderAiAgent(projection());

    expect(rendered).toContain("none recorded");
    expect(rendered).not.toContain("--events");
  });
});
