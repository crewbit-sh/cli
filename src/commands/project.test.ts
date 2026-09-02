import { describe, expect, test } from "bun:test";
import {
  type Fetch,
  fetchProject,
  fetchProjects,
  type ProjectProjection,
  renderProject,
  renderProjects,
} from "./project.ts";

const recording = (body: unknown) => {
  const asked: Array<{ url: string; headers: unknown }> = [];
  const get: Fetch = async (url, init) => {
    asked.push({ url, headers: init.headers });
    return { ok: true, json: async () => body } as Response;
  };
  return { asked, get };
};

describe("reading the org's Projects off the server", () => {
  test("asks the right path with the credential as a bearer token", async () => {
    const { asked, get } = recording({ projects: [] });

    await fetchProjects("https://app.crewbit.sh", "crw_abc", { get });

    expect(asked).toEqual([
      { url: "https://app.crewbit.sh/api/projects", headers: { authorization: "Bearer crw_abc" } },
    ]);
  });

  test("a trailing slash on the server does not double up", async () => {
    const { asked, get } = recording({ projects: [] });

    await fetchProjects("https://app.crewbit.sh/", "crw_abc", { get });

    expect(asked.map((one) => one.url)).toEqual(["https://app.crewbit.sh/api/projects"]);
  });

  test("an id with a slash in it is escaped rather than becoming a path", async () => {
    const { asked, get } = recording({ project: {}, sources: [] });

    await fetchProject("s", "a/b", "t", { get });

    expect(asked.map((one) => one.url)).toEqual(["s/api/projects/a%2Fb"]);
  });

  test("a refusal carries the status and what the server said", async () => {
    const get: Fetch = async () =>
      ({ ok: false, status: 404, statusText: "", text: async () => "no such project" }) as Response;

    expect(await fetchProject("s", "p", "t", { get })).toEqual({
      ok: false,
      status: 404,
      reason: "no such project",
    });
  });
});

describe("what the listing prints", () => {
  test("names each Project and its id, because the id is what every other command takes", () => {
    const printed = renderProjects([
      { id: "proj_2", name: "atlas", orgId: "org_1" },
      { id: "proj_1", name: "zephyr", orgId: "org_1" },
    ]);

    expect(printed).toContain("proj_2");
    expect(printed).toContain("atlas");
    expect(printed).toContain("zephyr");
  });

  test("says so plainly when the org has none, rather than printing a header alone", () => {
    expect(renderProjects([])).toContain("No project");
  });
});

describe("what reading one prints", () => {
  const projection: ProjectProjection = {
    project: { id: "proj_1", name: "atlas", orgId: "org_1" },
    sources: [
      {
        provider: "github",
        source: "acme/api",
        verify: "pnpm test",
        prepare: null,
        baseBranch: null,
        externalId: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        capabilities: ["spec.get", "spec.list"],
      },
    ],
  };

  test("names each source and what it answers for", () => {
    const printed = renderProject(projection);

    expect(printed).toContain("acme/api");
    expect(printed).toContain("spec.get");
    expect(printed).toContain("spec.list");
  });

  /** The one source the fixture has, with one field said differently. */
  const withSource = (over: Partial<(typeof projection)["sources"][number]>) => ({
    ...projection,
    sources: projection.sources.map((source) => ({ ...source, ...over })),
  });

  test("counts them too, so a source answering none is readable at a glance", () => {
    const printed = renderProject(withSource({ capabilities: [] }));

    expect(printed).toContain("acme/api");
    expect(printed).toMatch(/none/i);
  });

  test("says a source has no check rather than printing an empty command", () => {
    const printed = renderProject(withSource({ verify: null }));

    expect(printed).not.toContain("Verify: \n");
  });
});
