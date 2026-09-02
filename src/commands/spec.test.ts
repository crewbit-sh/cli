import { describe, expect, test } from "bun:test";
import { type Fetch, fetchSpecs, type Listed, renderSpecs } from "./spec.ts";

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
