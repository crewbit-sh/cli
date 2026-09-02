import { parseArgs } from "node:util";
import { createLogger, errorFields } from "../log.ts";

export const SPEC_USAGE = `  --project <id>     which Project's Specs, for \`list\`, from \`crewbit project list\`
  --token <token>    credential minted on the server's credentials page, or $CREWBIT_TOKEN
  --server <url>     where the Project lives (default https://app.crewbit.sh)
  --output <format>  ai_agent (default) or json, the response's own body`;

/** Injected so this is testable without the network, the same seam `run.ts` uses. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type SpecSummary = { key: string; title: string; labels: string[]; updatedAt: string };

/** One source's answer: what it listed, or why it could not be read. */
export type Listed = { source: string; specs?: SpecSummary[]; problem?: string };

export type FetchSpecsResult =
  | { ok: true; body: { sources: Listed[] } }
  | { ok: false; status: number; reason: string };

export async function fetchSpecs(
  server: string,
  projectId: string,
  token: string,
  options: { get?: Fetch } = {},
): Promise<FetchSpecsResult> {
  const { get = fetch } = options;
  const query = new URLSearchParams({ project: projectId });
  const url = `${server.replace(/\/+$/, "")}/api/specs?${query}`;
  const response = await get(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const reason = await response.text().catch(() => response.statusText);
    return { ok: false, status: response.status, reason };
  }
  return { ok: true, body: (await response.json()) as { sources: Listed[] } };
}

export type PlanResult =
  | { ok: true; body: { runId?: string } }
  | { ok: false; status: number; reason: string };

/**
 * Starting a Run for one Spec. The reference is passed through as the person
 * typed it and split on the server, so the two do not each own half of a rule
 * about where the `#` is.
 */
export async function planSpec(
  server: string,
  ref: string,
  token: string,
  options: { send?: Fetch } = {},
): Promise<PlanResult> {
  const { send = fetch } = options;
  const response = await send(`${server.replace(/\/+$/, "")}/api/specs/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ spec: ref }),
  });
  if (!response.ok) {
    const reason = await response.text().catch(() => response.statusText);
    return { ok: false, status: response.status, reason };
  }
  return { ok: true, body: (await response.json()) as { runId?: string } };
}

export function renderPlanned(body: { runId?: string }): string {
  if (!body.runId) return "Planning started.";
  return [
    `Planning started: ${body.runId}`,
    "",
    `Read it with \`crewbit run view ${body.runId}\`.`,
    "Nothing is implemented until you approve the plan.",
  ].join("\n");
}

export function renderSpecs(sources: Listed[]): string {
  if (!sources.length) return "No source attached to this Project. Nothing can be listed.";

  const lines: string[] = [];
  for (const one of sources) {
    lines.push(`${one.source}:`);
    if (one.problem) {
      // Named rather than shown as empty. A repository nobody can reach and one
      // with no open issues read identically otherwise, and only one of them is
      // somebody's mistake.
      lines.push(`  could not be read: ${one.problem}`);
    } else if (!one.specs?.length) {
      lines.push("  none open");
    } else {
      for (const spec of one.specs) {
        // `source#key` and not the key alone: it is exactly what `crewbit spec
        // plan` takes, so the next command is a copy rather than a construction.
        const labels = spec.labels.length ? `  [${spec.labels.join(", ")}]` : "";
        lines.push(`  ${one.source}#${spec.key}  ${spec.title}${labels}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function runSpec(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      token: { type: "string" },
      server: { type: "string", default: "https://app.crewbit.sh" },
      output: { type: "string", default: "ai_agent" },
    },
  });

  const log = createLogger("crewbit-spec");
  const [verb, ref] = positionals;

  if (verb !== "list" && verb !== "plan") {
    log.error(
      `no "${verb ?? ""}" here: it is \`crewbit spec list --project <id>\` or \`crewbit spec plan acme/api#12\``,
    );
    process.exit(1);
  }
  if (verb === "list" && !values.project) {
    log.error("no Project given: pass --project <id>, which `crewbit project list` prints");
    process.exit(1);
  }
  if (verb === "plan" && !ref) {
    log.error("no Spec given: pass `crewbit spec plan acme/api#12`, the pair `spec list` prints");
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

  let result: FetchSpecsResult | PlanResult;
  try {
    result =
      verb === "list"
        ? await fetchSpecs(values.server, values.project as string, token)
        : await planSpec(values.server, ref as string, token);
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
      ? renderSpecs((result.body as { sources: Listed[] }).sources)
      : renderPlanned(result.body as { runId?: string }),
  );
}
