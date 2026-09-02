import { parseArgs } from "node:util";
import { createLogger, errorFields } from "../log.ts";

export const PROJECT_USAGE = `  --token <token>    credential minted on the server's credentials page, or $CREWBIT_TOKEN
  --server <url>     where the Project lives (default https://app.crewbit.sh)
  --output <format>  ai_agent (default) or json, the response's own body`;

/** Injected so this is testable without the network, the same seam `run.ts` uses. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Fetched<T> = { ok: true; body: T } | { ok: false; status: number; reason: string };

export type Project = { id: string; name: string; orgId: string };

export type ProjectSourceView = {
  provider: string;
  source: string;
  verify: string | null;
  prepare: string | null;
  baseBranch: string | null;
  externalId: string | null;
  createdAt: string;
  capabilities: string[];
};

export type ProjectProjection = { project: Project; sources: ProjectSourceView[] };

async function read<T>(
  server: string,
  path: string,
  token: string,
  get: Fetch,
): Promise<Fetched<T>> {
  const url = `${server.replace(/\/+$/, "")}${path}`;
  const response = await get(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const reason = await response.text().catch(() => response.statusText);
    return { ok: false, status: response.status, reason };
  }
  return { ok: true, body: (await response.json()) as T };
}

export function fetchProjects(
  server: string,
  token: string,
  options: { get?: Fetch } = {},
): Promise<Fetched<{ projects: Project[] }>> {
  return read(server, "/api/projects", token, options.get ?? fetch);
}

export function fetchProject(
  server: string,
  id: string,
  token: string,
  options: { get?: Fetch } = {},
): Promise<Fetched<ProjectProjection>> {
  // Encoded, because a Project id is whatever the server minted and a slash in
  // one would otherwise become a path segment and answer 404 for the wrong
  // reason.
  return read(server, `/api/projects/${encodeURIComponent(id)}`, token, options.get ?? fetch);
}

export function renderProjects(projects: Project[]): string {
  if (!projects.length) {
    return "No project on this org yet. One appears the first time a Spec is synced.";
  }
  // The id first, because it is what every other command takes and the name is
  // what a person recognises. Printing only the name would mean a second lookup
  // for anything you actually want to do next.
  const width = Math.max(...projects.map((one) => one.id.length));
  return projects.map((one) => `${one.id.padEnd(width)}  ${one.name}`).join("\n");
}

export function renderProject({ project, sources }: ProjectProjection): string {
  const lines = [`Project ${project.id}: ${project.name}`, ""];
  if (!sources.length) {
    lines.push("No source attached. Nothing will sync until one is.");
    return lines.join("\n");
  }

  lines.push(`Sources (${sources.length}):`);
  for (const source of sources) {
    lines.push(`  ${source.source} (${source.provider})`);
    lines.push(`    Verify:  ${source.verify ?? "the install's own"}`);
    lines.push(`    Prepare: ${source.prepare ?? "nothing"}`);
    // Named and counted both: the count is what a person compares against what
    // the provider serves, and the names are what says which one is missing.
    lines.push(
      source.capabilities.length
        ? `    Answers for (${source.capabilities.length}): ${source.capabilities.join(", ")}`
        : "    Answers for: none. A capability bound nowhere resolves to nothing.",
    );
  }
  return lines.join("\n");
}

export async function runProject(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      token: { type: "string" },
      server: { type: "string", default: "https://app.crewbit.sh" },
      output: { type: "string", default: "ai_agent" },
    },
  });

  const log = createLogger("crewbit-project");
  const [verb, id] = positionals;

  if (verb !== "list" && verb !== "view") {
    log.error(
      `no "${verb ?? ""}" here: it is \`crewbit project list\` or \`crewbit project view <id>\``,
    );
    process.exit(1);
  }
  if (verb === "view" && !id) {
    log.error(
      "no Project id given: pass `crewbit project view <id>`, or run `crewbit project list`",
    );
    process.exit(1);
  }

  const token = values.token ?? process.env.CREWBIT_TOKEN;
  if (!token) {
    log.error("no token given: pass --token or set CREWBIT_TOKEN");
    process.exit(1);
  }

  if (values.output !== "ai_agent" && values.output !== "json") {
    log.error(`no "${values.output}" output: it is ai_agent or json`);
    process.exit(1);
  }

  let result: Fetched<{ projects: Project[] }> | Fetched<ProjectProjection>;
  try {
    result =
      verb === "list"
        ? await fetchProjects(values.server, token)
        : await fetchProject(values.server, id as string, token);
  } catch (cause) {
    log.error("could not reach the server", { url: values.server, ...errorFields(cause) });
    process.exit(1);
  }

  if (!result.ok) {
    log.error(result.reason || `the server answered ${result.status}`, { status: result.status });
    process.exit(1);
  }

  if (values.output === "json") {
    console.log(JSON.stringify(result.body, null, 2));
    return;
  }
  console.log(
    verb === "list"
      ? renderProjects((result.body as { projects: Project[] }).projects)
      : renderProject(result.body as ProjectProjection),
  );
}
