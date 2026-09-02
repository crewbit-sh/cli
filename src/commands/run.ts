import { parseArgs } from "node:util";
import { createLogger, errorFields } from "../log.ts";

export const RUN_USAGE = `  --reason <text>    why, for \`reject\`, and it is what the next plan reads
  --token <token>    credential minted on the server's credentials page, or $CREWBIT_TOKEN
  --server <url>     where the Run lives (default https://app.crewbit.sh)
  --output <format>  ai_agent (default) or json, the response's own body
  --events <n>       how many recent events to fetch (default 0: counted, not fetched)`;

/** Injected so this is testable without the network, the same seam `latest.ts` uses. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type FetchRunResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; reason: string };

/**
 * `GET /api/runs/:id` on the server, authenticated with the same credential
 * the runner already dials the socket with: `crewbit-v2`'s `runForOrg` reads
 * it as an org, never a person, so there is no second credential to hold.
 */
export async function fetchRun(
  server: string,
  id: string,
  token: string,
  options: { events?: number; get?: Fetch } = {},
): Promise<FetchRunResult> {
  const { events, get = fetch } = options;
  const path = `/api/runs/${encodeURIComponent(id)}`;
  const url = `${server.replace(/\/+$/, "")}${path}${events !== undefined ? `?limit=${events}` : ""}`;
  const response = await get(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const reason = await response.text().catch(() => response.statusText);
    return { ok: false, status: response.status, reason };
  }
  return { ok: true, body: await response.json() };
}

export type Gate = "approve" | "reject" | "replan";

export type GateResult =
  | { ok: true; body: { runId?: string } }
  | { ok: false; status: number; reason: string };

/**
 * Answering the plan gate. The decision is still a person's; this is only where
 * they press it, and until now the only place was a browser.
 */
export async function answerGate(
  server: string,
  id: string,
  gate: Gate,
  token: string,
  options: { reason?: string; send?: Fetch } = {},
): Promise<GateResult> {
  const { reason, send = fetch } = options;
  const url = `${server.replace(/\/+$/, "")}/api/runs/${encodeURIComponent(id)}/${gate}`;
  const response = await send(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    return { ok: false, status: response.status, reason: text };
  }
  return { ok: true, body: (await response.json()) as { runId?: string } };
}

/** What happens next, which nothing else is going to say on a terminal. */
export function renderAnswered(gate: Gate, id: string): string {
  const said: Record<Gate, string> = {
    approve: "the code stage runs next, on whichever runner takes it",
    reject: "it waits on the Spec being improved, and your reason is what the next plan reads",
    replan: "the plan stage runs again, from the Spec as it is now",
  };
  return `${id}: ${said[gate]}.`;
}

type RunView = {
  id: string;
  state: string;
  title: string;
  source: string;
  externalKey: string;
  provider: string;
  reviewUrl: string | null;
  updatedAt: string;
  costUsd: number | null;
  jobState: string | null;
  jobStage: string | null;
  jobRunner: string | null;
  lastStage: string | null;
  lastTurns: number | null;
  lastTurnsMax: number | null;
};

type Transition = { from: string; to: string; cause: string; at: string };
type TranscriptLine = { kind: string; payload: string; stage: string; createdAt: string };

export type RunProjection = {
  run: RunView;
  transitions: Transition[];
  events: { lines: TranscriptLine[]; total: number };
};

/** `Xm`, `Xh` or `Xd`: enough resolution to tell "just now" from "stuck". */
function since(at: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(at));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * What a line meant, read the way `web/pages/run.ts`'s own transcript does:
 * the payload is the engine's, so nothing in it is trusted or assumed present.
 */
function summarise(line: TranscriptLine): string {
  try {
    const event = JSON.parse(line.payload) as Record<string, string>;
    if (event.t === "assistant") return truncate(event.text ?? line.kind);
    if (event.t === "tool_use") return truncate(`${event.name ?? "tool"} ${event.summary ?? ""}`);
    if (event.t === "rate_limit") return `rate limit (${event.rateLimitType ?? "?"})`;
    return line.kind;
  } catch {
    return line.kind;
  }
}

/**
 * A Run's state answers "what", never "how long", and a Run stuck for two
 * minutes and one stuck for two days read identically without this: the last
 * transition's own timestamp says exactly when the current state began.
 * `updatedAt` is the fallback, for a Run that has not transitioned at all yet.
 *
 * This cannot say whether the capability the Run is waiting on was ever
 * served: the projection carries no binding, by decision, and `docs/status.md`
 * in `crewbit-v2` names that gap. What it says instead is honest: how long,
 * and where to look by hand.
 */
export function renderAiAgent(projection: RunProjection, now = new Date()): string {
  const { run, transitions, events } = projection;
  const last = transitions.at(-1);
  const enteredCurrentState = last?.at ?? run.updatedAt;

  const lines = [
    `Run ${run.id}: ${run.title}`,
    `State: ${run.state} (${since(enteredCurrentState, now)} since it got here)`,
    `Spec: ${run.provider}#${run.externalKey} at ${run.source}`,
    `Review: ${run.reviewUrl ?? "none opened yet"}`,
    run.jobStage
      ? `Job: ${run.jobStage} (${run.jobState})${run.jobRunner ? `, held by ${run.jobRunner}` : ""}`
      : "Job: none outstanding",
    run.lastStage
      ? `Last stage run: ${run.lastStage}, ${run.lastTurns ?? "?"}/${run.lastTurnsMax ?? "?"} turns`
      : "No stage has run yet",
    run.costUsd !== null ? `Cost so far: $${run.costUsd.toFixed(2)}` : "Cost so far: nothing yet",
    "",
    `Transitions (${transitions.length}, oldest first):`,
    ...(transitions.length
      ? transitions.map((t) => `  ${t.from} -> ${t.to} (${t.cause}) at ${t.at}`)
      : ["  none yet"]),
    "",
    `Events (${events.lines.length} of ${events.total}, newest first):`,
    ...(events.lines.length
      ? events.lines.map((e) => `  [${e.stage}] ${summarise(e)}`)
      : events.total > 0
        ? [`  ${events.total} recorded, none fetched. Pass --events <n> to read them.`]
        : ["  none recorded"]),
  ];
  return lines.join("\n");
}

export async function runRun(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      token: { type: "string" },
      server: { type: "string", default: "https://app.crewbit.sh" },
      output: { type: "string", default: "ai_agent" },
      events: { type: "string" },
      reason: { type: "string" },
    },
  });

  const log = createLogger("crewbit-run");
  const [verb, id] = positionals;
  const GATES: Gate[] = ["approve", "reject", "replan"];

  // `crewbit run <id>` was the whole command in v0.5.0 and is gone. An id is not
  // a verb, so it is named back rather than read as one: reading it as a verb
  // would answer "no Run id given" for somebody who gave exactly that.
  const gate = GATES.find((one) => one === verb);
  if (verb !== "view" && !gate) {
    // The exact form and not only the verb list. `crewbit run <id>` was the
    // whole command in v0.5.0, so the commonest way to land here is an id where
    // a verb goes, and that person needs the line to type rather than a menu.
    const forms = `\`crewbit run view <id>\`, and the verbs are view, ${GATES.join(", ")}`;
    log.error(
      verb ? `no "${verb}" here: reading one Run is ${forms}` : `nothing asked: it is ${forms}`,
    );
    process.exit(1);
  }
  if (!id) {
    log.error(`no Run id given: pass \`crewbit run ${verb} <id>\``);
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

  let events: number | undefined;
  if (values.events !== undefined) {
    events = Number(values.events);
    if (!Number.isInteger(events) || events < 0) {
      log.error(`--events wants a whole number of zero or more, not "${values.events}"`);
      process.exit(1);
    }
  }

  let result: FetchRunResult | GateResult;
  try {
    result = gate
      ? await answerGate(values.server, id, gate, token, { reason: values.reason })
      : await fetchRun(values.server, id, token, { events });
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
  console.log(gate ? renderAnswered(gate, id) : renderAiAgent(result.body as RunProjection));
}
