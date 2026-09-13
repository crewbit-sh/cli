import { describe, expect, test } from "bun:test";
import type { RunProjection } from "./run.ts";
import {
  type Fetch,
  fetchSpecs,
  type Listed,
  planSpec,
  renderPlanned,
  renderSpecs,
  renderStarted,
  runSpecNow,
} from "./spec.ts";

const AT = "2026-08-24T12:00:00Z";

function projection(over: Partial<RunProjection["run"]> = {}): RunProjection {
  return {
    run: {
      id: "run_1",
      state: "coding",
      title: "add the health endpoint",
      source: "acme/api",
      externalKey: "12",
      provider: "github",
      reviewUrl: null,
      updatedAt: AT,
      costUsd: null,
      jobState: "running",
      jobStage: "code",
      jobRunner: "runner_1",
      lastStage: null,
      lastTurns: null,
      lastTurnsMax: null,
      ...over,
    },
    transitions: [],
    events: { lines: [], total: 0 },
    artifacts: {},
  };
}

describe("reading a Project's Specs off the server", () => {
  test("asks the right path with the project as a query and the credential as a bearer", async () => {
    const asked: Array<{ url: string; headers: unknown }> = [];
    const get: Fetch = async (url, init) => {
      asked.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ sources: [] }) } as Response;
    };

    await fetchSpecs("https://app.crewbit.sh", "proj_1", "crw_abc", { get });

    expect(asked).toEqual([
      {
        url: "https://app.crewbit.sh/api/specs?project=proj_1",
        headers: { authorization: "Bearer crw_abc" },
      },
    ]);
  });

  test("a project id with a character that needs escaping does not become a second parameter", async () => {
    const asked: string[] = [];
    const get: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ sources: [] }) } as Response;
    };

    await fetchSpecs("https://s", "a&b=c", "t", { get });

    expect(asked).toEqual(["https://s/api/specs?project=a%26b%3Dc"]);
  });

  test("a --server that is not http or https is refused without calling get", async () => {
    const get: Fetch = async () => {
      throw new Error("get must not be called");
    };

    const result = await fetchSpecs("ws://127.0.0.1:1", "proj_1", "t", { get });

    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toContain("http");
  });

  test("a refusal carries the status and what the server said", async () => {
    const get: Fetch = async () =>
      ({ ok: false, status: 400, statusText: "", text: async () => "pass ?project=" }) as Response;

    expect(await fetchSpecs("https://s", "", "t", { get })).toEqual({
      ok: false,
      status: 400,
      reason: "pass ?project=",
    });
  });
});

describe("what the listing prints", () => {
  const spec = (key: string, title: string, labels: string[] = []) => ({
    key,
    title,
    labels,
    updatedAt: "2026-09-02T00:00:00Z",
  });

  test("names each Spec under the source it came from", () => {
    const listed: Listed[] = [
      { source: "acme/api", specs: [spec("12", "add the health endpoint")] },
      { source: "acme/tools", specs: [spec("3", "drop the old flag")] },
    ];

    const printed = renderSpecs(listed);

    expect(printed).toContain("acme/api");
    expect(printed).toContain("12");
    expect(printed).toContain("add the health endpoint");
    expect(printed).toContain("acme/tools");
  });

  test("prints the pair `spec plan` takes, so the next command is copyable", () => {
    const printed = renderSpecs([{ source: "acme/api", specs: [spec("12", "t")] }]);

    expect(printed).toContain("acme/api#12");
  });

  test("a source that could not be read is named, never shown as empty", () => {
    // The one thing this must not do: an unreachable repository and one with no
    // open issues answer identically otherwise, and only one is somebody's
    // mistake.
    const printed = renderSpecs([{ source: "acme/api", problem: "HTTP 404" }]);

    expect(printed).toContain("acme/api");
    expect(printed).toContain("HTTP 404");
    expect(printed).not.toMatch(/no open spec/i);
  });

  test("a source that answered nothing says so, and is not confused with one that failed", () => {
    const printed = renderSpecs([{ source: "acme/api", specs: [] }]);

    expect(printed).toMatch(/none/i);
    expect(printed).not.toContain("could not");
  });

  test("says the Project has no source at all rather than printing a blank", () => {
    expect(renderSpecs([])).toContain("No source");
  });
});

describe("planning one Spec through the server", () => {
  test("posts the reference as given, with the credential as a bearer token", async () => {
    const asked: Array<{ url: string; init: RequestInit }> = [];
    const send: Fetch = async (url, init) => {
      asked.push({ url, init });
      return { ok: true, json: async () => ({ runId: "run_1" }) } as Response;
    };

    await planSpec("https://app.crewbit.sh", "acme/api#12", "crw_abc", { send });

    expect(asked[0]?.url).toBe("https://app.crewbit.sh/api/specs/plan");
    expect(asked[0]?.init.method).toBe("POST");
    expect(asked[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer crw_abc",
    });
    expect(JSON.parse(String(asked[0]?.init.body))).toEqual({ spec: "acme/api#12" });
  });

  test("a refusal carries the server's words, which is the whole answer", async () => {
    // The reason is what says which capability is unserved or which Specs this
    // one waits on. A status alone would throw away the only useful part.
    const send: Fetch = async () =>
      ({
        ok: false,
        status: 409,
        statusText: "",
        text: async () => "blocked: this Spec waits on one Spec that has not landed",
      }) as Response;

    expect(await planSpec("https://s", "a/b#1", "t", { send })).toEqual({
      ok: false,
      status: 409,
      reason: "blocked: this Spec waits on one Spec that has not landed",
    });
  });

  test("a --server that is not http or https is refused without calling send", async () => {
    const send: Fetch = async () => {
      throw new Error("send must not be called");
    };

    const result = await planSpec("ws://127.0.0.1:1", "acme/api#12", "t", { send });

    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toContain("http");
  });
});

describe("what a started Run prints", () => {
  test("names the Run and how to read it, because that is the next thing anybody does", () => {
    const printed = renderPlanned({ runId: "run_1" });

    expect(printed).toContain("run_1");
    expect(printed).toContain("crewbit run view run_1");
  });

  test("says a Run started even when the server named none", () => {
    // The route answers `{ runId: undefined }` for an outcome that succeeded
    // without one rather than pretending it failed.
    expect(renderPlanned({})).not.toContain("undefined");
  });
});

describe("what the fast path prints once the Run has opened", () => {
  test("names the Run and how to read it, with no plan-gate line: coding has already begun", () => {
    const printed = renderStarted("run_1");

    expect(printed).toContain("run_1");
    expect(printed).toContain("crewbit run view run_1");
    expect(printed).not.toMatch(/approve/i);
  });

  test("says nothing broke when the server named no id", () => {
    expect(renderStarted(undefined)).not.toContain("undefined");
  });

  test("strips control characters, since the id is the server's own", () => {
    const printed = renderStarted("run_1\n\x1b[31mFAKE");

    expect(printed).not.toContain("\n\x1b");
  });
});

describe("running one Spec straight through", () => {
  test("posts the reference to the server's own run route, with the credential as a bearer", async () => {
    const asked: Array<{ url: string; init: RequestInit }> = [];
    const send: Fetch = async (url, init) => {
      asked.push({ url, init });
      return { ok: true, json: async () => ({ runId: "run_1", state: "planning" }) } as Response;
    };

    await runSpecNow("https://app.crewbit.sh", "acme/api#12", "crw_abc", { send });

    expect(asked[0]?.url).toBe("https://app.crewbit.sh/api/specs/run");
    expect(asked[0]?.init.method).toBe("POST");
    expect(asked[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer crw_abc",
    });
    expect(JSON.parse(String(asked[0]?.init.body))).toEqual({ spec: "acme/api#12" });
  });

  test("passes a reference through untouched, so an id works where a pair does", async () => {
    // `spec plan` splits nothing either: one rule about where the `#` is, and it
    // lives on the server.
    const asked: RequestInit[] = [];
    const send: Fetch = async (_url, init) => {
      asked.push(init);
      return { ok: true, json: async () => ({}) } as Response;
    };

    await runSpecNow("https://s", "spec_abc123", "t", { send });

    expect(JSON.parse(String(asked[0]?.body))).toEqual({ spec: "spec_abc123" });
  });

  test("a trailing slash on the server does not double up", async () => {
    const asked: string[] = [];
    const send: Fetch = async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({}) } as Response;
    };

    await runSpecNow("https://app.crewbit.sh/", "a/b#1", "t", { send });

    expect(asked).toEqual(["https://app.crewbit.sh/api/specs/run"]);
  });

  test("carries the Run projection the server started back", async () => {
    // #299: this route answers the same full projection every acting route
    // does, not the flat {runId, state} it used to.
    const body = projection();
    const send: Fetch = async () =>
      ({ ok: true, status: 200, statusText: "", json: async () => body }) as Response;

    expect(await runSpecNow("https://s", "a/b#1", "t", { send })).toEqual({ ok: true, body });
  });

  test("a refusal carries the server's words, which is the whole answer", async () => {
    const send: Fetch = async () =>
      ({
        ok: false,
        status: 409,
        statusText: "",
        text: async () => "blocked: this Spec waits on one Spec that has not landed",
      }) as Response;

    expect(await runSpecNow("https://s", "a/b#1", "t", { send })).toEqual({
      ok: false,
      status: 409,
      reason: "blocked: this Spec waits on one Spec that has not landed",
    });
  });
});
