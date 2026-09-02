import { describe, expect, test } from "bun:test";
import {
  type Fetch,
  fetchSpecs,
  type Listed,
  planSpec,
  renderPlanned,
  renderSpecs,
} from "./spec.ts";

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

    await fetchSpecs("s", "a&b=c", "t", { get });

    expect(asked).toEqual(["s/api/specs?project=a%26b%3Dc"]);
  });

  test("a refusal carries the status and what the server said", async () => {
    const get: Fetch = async () =>
      ({ ok: false, status: 400, statusText: "", text: async () => "pass ?project=" }) as Response;

    expect(await fetchSpecs("s", "", "t", { get })).toEqual({
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

    expect(await planSpec("s", "a/b#1", "t", { send })).toEqual({
      ok: false,
      status: 409,
      reason: "blocked: this Spec waits on one Spec that has not landed",
    });
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
