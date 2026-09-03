import { describe, expect, test } from "bun:test";
import {
  answerGate,
  type Fetch,
  fetchRun,
  fetchRuns,
  pickArtifact,
  type RunProjection,
  type RunView,
  renderAiAgent,
  renderAnswered,
  renderRuns,
} from "./run.ts";

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

describe("listing the org's live Runs", () => {
  test("asks the right path with the credential as a bearer token", async () => {
    const asked: Array<{ url: string; headers: unknown }> = [];
    const get: Fetch = async (url, init) => {
      asked.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ runs: [] }) } as Response;
    };

    await fetchRuns("https://app.crewbit.sh", "crw_abc", { get });

    expect(asked).toEqual([
      { url: "https://app.crewbit.sh/api/runs", headers: { authorization: "Bearer crw_abc" } },
    ]);
  });

  test("a trailing slash on the server does not double up", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ runs: [] }) } as Response;
    };

    await fetchRuns("https://app.crewbit.sh/", "t", { get });

    expect(asked).toEqual(["https://app.crewbit.sh/api/runs"]);
  });

  test("--limit becomes ?limit= on the request", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ runs: [] }) } as Response;
    };

    await fetchRuns("s", "t", { limit: 5, get });

    expect(asked).toEqual(["s/api/runs?limit=5"]);
  });

  test("carries the body back on success", async () => {
    const body = { runs: [{ id: "r" }] } as unknown as { runs: RunView[] };
    const result = await fetchRuns("s", "t", { get: answering(body) });

    expect(result).toEqual({ ok: true, body });
  });

  test("a refusal carries the status and what the server said", async () => {
    const get: Fetch = async () =>
      ({ ok: false, status: 401, statusText: "", text: async () => "no such token" }) as Response;

    const result = await fetchRuns("s", "t", { get });

    expect(result).toEqual({ ok: false, status: 401, reason: "no such token" });
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
    artifacts: {},
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

  test("lists the artifacts a stage left behind, so a reader knows what to ask for", () => {
    const withArtifacts = projection();
    withArtifacts.artifacts = {
      "engine.txt": "the engine stopped at the turn ceiling",
      "result.md": "done",
    };

    const rendered = renderAiAgent(withArtifacts);

    expect(rendered).toContain(
      "Artifacts: engine.txt, result.md (pass --artifact <name> to read one)",
    );
  });

  test("says none, not the hint, when the stage left nothing behind", () => {
    const rendered = renderAiAgent(projection());

    expect(rendered).toContain("Artifacts: none");
    expect(rendered).not.toContain("--artifact");
  });
});

describe("the run list rendering", () => {
  const run = (over: Partial<RunView> = {}): RunView => ({
    id: "run_1",
    state: "in_review",
    title: "say what a Job is doing",
    source: "acme/api",
    externalKey: "6",
    provider: "github",
    reviewUrl: null,
    updatedAt: AT,
    costUsd: null,
    jobState: null,
    jobStage: null,
    jobRunner: null,
    lastStage: null,
    lastTurns: null,
    lastTurnsMax: null,
    ...over,
  });

  test("one line per Run, in the order the server sent them", () => {
    const rendered = renderRuns([run({ id: "run_1" }), run({ id: "run_2" })]);

    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered.indexOf("run_1")).toBeLessThan(rendered.indexOf("run_2"));
  });

  test("names the state, the Spec and the title", () => {
    const rendered = renderRuns([
      run({ state: "coding", source: "acme/api", externalKey: "9", title: "fix the thing" }),
    ]);

    expect(rendered).toContain("coding");
    expect(rendered).toContain("acme/api#9");
    expect(rendered).toContain("fix the thing");
  });

  test("says how long since it was last touched", () => {
    const rendered = renderRuns([run({ updatedAt: AT })], new Date(Date.parse(AT) + 34 * HOUR));

    expect(rendered).toContain("34h");
  });

  test("says plainly when there is nothing live, rather than an empty line", () => {
    expect(renderRuns([])).toMatch(/no live run/i);
  });
});

describe("picking one artifact by name", () => {
  test("an existing name returns its content", () => {
    const result = pickArtifact({ "engine.txt": "stopped at the ceiling" }, "engine.txt");

    expect(result).toEqual({ ok: true, content: "stopped at the ceiling" });
  });

  test("a missing name lists what exists instead", () => {
    const result = pickArtifact({ "engine.txt": "x", "result.md": "y" }, "verify.txt");

    expect(result).toEqual({
      ok: false,
      message: 'no "verify.txt" artifact: it is engine.txt, result.md',
    });
  });

  test("a missing name against no artifacts at all says there is none yet", () => {
    const result = pickArtifact({}, "engine.txt");

    expect(result).toEqual({
      ok: false,
      message: 'no "engine.txt" artifact: this Run has none yet',
    });
  });
});

describe("answering the plan gate", () => {
  test("posts the action under the Run, with the credential as a bearer token", async () => {
    const asked: Array<{ url: string; init: RequestInit }> = [];
    const send: Fetch = async (url, init) => {
      asked.push({ url, init });
      return { ok: true, json: async () => ({ runId: "run_1" }) } as Response;
    };

    await answerGate("https://app.crewbit.sh", "run_1", "approve", "crw_abc", { send });

    expect(asked[0]?.url).toBe("https://app.crewbit.sh/api/runs/run_1/approve");
    expect(asked[0]?.init.method).toBe("POST");
    expect(asked[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer crw_abc",
    });
  });

  test("carries the reason when rejecting, because that is what the next plan reads", async () => {
    const asked: RequestInit[] = [];
    const send: Fetch = async (_url, init) => {
      asked.push(init);
      return { ok: true, json: async () => ({ runId: "run_1" }) } as Response;
    };

    await answerGate("s", "run_1", "reject", "t", { reason: "the surface is wrong", send });

    expect(JSON.parse(String(asked[0]?.body))).toEqual({ reason: "the surface is wrong" });
  });

  test("a refusal carries the server's words, which say what to do next", async () => {
    const send: Fetch = async () =>
      ({
        ok: false,
        status: 409,
        statusText: "",
        text: async () => "there is no plan to approve: plan it again first",
      }) as Response;

    expect(await answerGate("s", "r", "approve", "t", { send })).toEqual({
      ok: false,
      status: 409,
      reason: "there is no plan to approve: plan it again first",
    });
  });
});

describe("what an answered gate prints", () => {
  test("approving says what happens now, because nothing else will tell you", () => {
    const printed = renderAnswered("approve", "run_1");

    expect(printed).toContain("run_1");
    expect(printed).toMatch(/code/i);
  });

  test("rejecting says the Run is waiting on the Spec being improved", () => {
    expect(renderAnswered("reject", "run_1")).toMatch(/spec/i);
  });

  test("replanning says a new plan is coming, not that anything was approved", () => {
    const printed = renderAnswered("replan", "run_1");

    expect(printed).not.toMatch(/approv/i);
  });
});
