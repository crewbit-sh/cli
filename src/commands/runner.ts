import { parseArgs } from "node:util";
import { newestRelease } from "../latest.ts";
import { createLogger, type Logger } from "../log.ts";
import { claudeCliEngine } from "../runner/engine/claude-cli.ts";
import { fakeEngine } from "../runner/engine/fake.ts";
import type { Engine, EngineEvent } from "../runner/engine/types.ts";
import { REFUSED_HANDSHAKE, RUNNER_VERSION, startRunner } from "../runner/index.ts";
import { outdatedNotice } from "../version.ts";

export const RUNNER_USAGE = `  --token <token>  credential minted on the server's credentials page, or $CREWBIT_TOKEN
  --server <url>   where to dial (default wss://d.crewbit.sh/runner/v1)
  --slots <n>      how many Jobs to run at once (default 1)
  --fake           replay a recorded stream instead of spending tokens
  --quiet          only report Job outcomes, not the transcript`;

/**
 * The engines an operator can name. These are the `kind` strings the engine
 * itself reports and the handshake already sends to the server
 * (`src/runner/index.ts`), so what somebody types and what the server shows
 * them for the same Job is one vocabulary rather than two spellings needing a
 * mapping between them.
 */
export const ENGINE_NAMES = ["claude-cli", "fake"] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

/** Only the two flags the answer depends on, so the resolver takes nothing else. */
export type EngineFlags = { engine?: string; fake?: boolean };

const ENGINES: Record<EngineName, () => Engine> = {
  "claude-cli": () => claudeCliEngine(),
  fake: () => fakeEngine(),
};

/** Builds the engine a name stands for. Nothing is spawned until a Job runs. */
export function engineNamed(name: EngineName): Engine {
  return ENGINES[name]();
}

/**
 * argv to an engine name, and nothing else: no socket, no engine and no
 * process, which is what lets every branch be reached from a table.
 *
 * `--fake` is consulted only when `--engine` is absent. `--engine` did not
 * exist in 0.12.0, so no script written against the old flag carries both, and
 * argv with both was typed by somebody who knows the new one. The failure
 * directions are not symmetric either: the other rule makes
 * `--engine claude-cli --fake` a runner that dials a real server, takes real
 * Jobs and completes them out of a recording.
 */
export function resolveEngineName(
  values: EngineFlags,
): { ok: true; value: EngineName } | { ok: false; message: string } {
  if (values.engine === undefined) return { ok: true, value: values.fake ? "fake" : "claude-cli" };
  const named = ENGINE_NAMES.find((name) => name === values.engine);
  if (!named) {
    // Built from the list, so a third engine names itself here the day it is
    // added rather than the day somebody remembers this sentence.
    return {
      ok: false,
      message: `--engine has no "${values.engine}": the engines are ${ENGINE_NAMES.join(", ")}`,
    };
  }
  return { ok: true, value: named };
}

/**
 * The agent's own stream, through the given logger. Exported so a test can
 * drive it directly: `startRunner`'s own logger is not injectable from here,
 * and this is the only place a rate limit's `status` reaches the transcript.
 */
export function transcriptLogger(log: Logger): (jobId: string, event: EngineEvent) => void {
  return (jobId, event) => {
    if (event.t === "assistant") log.info(event.text, { job_id: jobId, event: "assistant" });
    else if (event.t === "tool_use") {
      log.info(`${event.name} ${event.summary ?? ""}`.trim(), {
        job_id: jobId,
        event: "tool_use",
        tool: event.name,
      });
    } else if (event.t === "rate_limit") {
      log.warning("rate limit", {
        job_id: jobId,
        event: "rate_limit",
        rate_limit_type: event.rateLimitType,
        resets_at: new Date(event.resetsAt * 1000).toISOString(),
        status: event.status,
      });
    }
  };
}

export async function runRunner(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      token: { type: "string" },
      server: { type: "string", default: "wss://d.crewbit.sh/runner/v1" },
      slots: { type: "string", default: "1" },
      engine: { type: "string" },
      fake: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
  });

  const token = values.token ?? process.env.CREWBIT_TOKEN;
  const log = createLogger("crewbit-runner");

  // Before the release check's fetch and before `startRunner`, so a name
  // nobody offers costs neither a request nor a dialled socket.
  const engine = resolveEngineName(values);
  if (!engine.ok) {
    log.error(engine.message);
    process.exit(1);
  }

  // Here rather than inside `startRunner`, so the library nobody's tests should
  // have to take offline never reaches a third party: the service drives this
  // package in its own suite, and a version check there would be a network call
  // per test. Never awaited either, which is the other half of `latest.ts`: a
  // runner behind an allowlist starts at the same speed as one that is not.
  void newestRelease()
    .then((newest) => {
      const notice = newest && outdatedNotice(RUNNER_VERSION, newest);
      if (notice) log.warning(notice, { version: RUNNER_VERSION, latest: newest });
    })
    .catch(() => {});

  const runner = await startRunner({
    url: values.server,
    // The env var is what a service manager sets; the flag is what a human types.
    token,
    slots: Number(values.slots),
    engine: engineNamed(engine.value),
    log,
    // Two formats on one stdout would hand a collector mixed content, and on a
    // server that is the only record of what the agent did.
    onEvent: values.quiet ? undefined : transcriptLogger(log),
    sweepWorkspaces: true,
  }).catch((cause: Error) => {
    // A refused upgrade surfaces here. A Bun stack trace tells a human nothing
    // about the one thing that is usually wrong, which is the credential.
    //
    // Unless the server answered the handshake and said no, which it only does for
    // a reason it names: the credential was good enough to get a socket, so
    // pointing the operator at the credentials page sends them to the wrong place.
    const refused = cause.message.startsWith(REFUSED_HANDSHAKE);
    log.error(cause.message, {
      url: values.server,
      ...(refused
        ? {}
        : {
            hint: token
              ? "the server closed the connection before the handshake: the credential may be revoked, or minted against another server, or the server may not be ready. Its credentials are at /runners"
              : "no token given: pass --token or set CREWBIT_TOKEN",
          }),
    });
    process.exit(1);
  });

  /**
   * The first signal drains: no new Jobs, and whatever is running finishes. The
   * second one is a person saying they meant it, and leaves now.
   *
   * Leaving at once loses the engine and everything it has not pushed, which is up
   * to a third of the lease. The Job survives, because the server reclaims it, but
   * the turns spent on it do not, and a code stage is thirty to ninety of them.
   */
  let asked = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (asked) {
        log.warning("runner stopping now, giving up what it was holding");
        process.exit(1);
      }
      asked = true;
      log.info(
        "runner draining: finishing what it holds, taking nothing new. Signal again to stop now",
      );
      void runner.stop({ drain: true }).then(() => process.exit(0));
    });
  }
}
