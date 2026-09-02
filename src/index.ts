/**
 * The runner: connect, announce, accept, execute, report.
 *
 * It knows the server and nothing else. No provider, no credential, no issue
 * tracker, no Run state. Everything it needs arrives inside the Job, and
 * everything it produces goes back as data for the server to decide about.
 *
 * Bun-only APIs are deliberately absent here, so this package also runs under
 * Node. A cloud runner on the Agent SDK is then the same package with a
 * different engine.
 */

import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  type JobAssignParams,
  type JobCompleteParams,
  type JobStatus,
  PROTOCOL_VERSION,
  RpcPeer,
  type RunnerCalls,
  type ServerCalls,
  type Stage,
} from "@crewbit/protocol";
import { type Batcher, createBatcher } from "./batcher.ts";
import { reportCompletion } from "./completion.ts";
import type { Engine, EngineEvent, EngineResult } from "./engine/types.ts";
import {
  alreadyOnRemote,
  commitAll,
  commitsSince,
  head,
  onRemote,
  pushed,
  remoteHead,
} from "./git.ts";
import { createLogger, errorFields, type Logger } from "./log.ts";
import { decide } from "./outcome.ts";
import { retryable, stopReason } from "./reason.ts";
import { runPrepare, runVerify } from "./verify.ts";
import { waited } from "./wait.ts";
import { prepareWorkspace } from "./workspace.ts";

export { buildArgs, buildEnv, claudeCliEngine } from "./engine/claude-cli.ts";
export { type FakeEngine, fakeEngine } from "./engine/fake.ts";
export { consumeStream, failedResult, parseLine } from "./engine/stream.ts";
export type { Engine, EngineEvent, EngineResult, EngineRun } from "./engine/types.ts";
export { createLogger, errorFields, type Logger } from "./log.ts";

export const RUNNER_VERSION = "0.3.0";
/**
 * How a handshake the server answered and declined reads. Exported because the
 * CLI tells this apart from every other way a connect fails: this one means the
 * credential worked, so the credential is not what the operator should go and
 * check.
 */
export const REFUSED_HANDSHAKE = "server refused the handshake";
const ALL_STAGES: Stage[] = ["plan", "code", "pr", "eval"];
/**
 * The Stages that put something on the remote. Everything else explores.
 *
 * An allowlist rather than `stage !== "plan"`, because `eval` reads the diff and
 * writes a verdict, and `pr` is a server action: neither has anything to deliver
 * either, and a denylist would keep pushing a branch and a `work in progress`
 * commit for both.
 *
 * This is the one thing the runner knows about what a Stage means, and it dents
 * how generic the runner is. The right home is the server declaring it on the
 * Job, which is a `JobAssignParams` change and so a protocol change; when that
 * happens this list is the field's default.
 */
const DELIVERING_STAGES: Set<Stage> = new Set(["code"]);
const delivers = (stage: Stage): boolean => DELIVERING_STAGES.has(stage);
/**
 * Stages that work on top of the branch the Run already has, which is not the
 * same set as the ones that push to it: the eval stage reads the change and
 * delivers nothing. Deriving one from the other gave every eval a fresh branch
 * at the base's tip, and every verdict was about an empty diff.
 */
const CONTINUING_STAGES: Set<Stage> = new Set(["code", "eval"]);
const continues = (stage: Stage): boolean => CONTINUING_STAGES.has(stage);
const RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
/**
 * How long a reconnecting runner keeps trying while the server refuses it.
 *
 * A refusal means another connection holds this runnerId, which is permanent
 * when a second process is claiming it and temporary when the incumbent is this
 * runner's own half-open socket. The runner cannot tell them apart, and the
 * server closes a ghost after at most `30s × (3 + 1)` of unanswered pings, so
 * the window is comfortably past that and then gives up: a Job in hand is worth
 * two minutes of waiting, and dialling forever is not.
 */
const REFUSAL_PATIENCE_MS = 180_000;
/**
 * How many times the engine is spawned for one Job before its failure is
 * reported. Three, so a bad minute costs 90s of waiting rather than a Run: an
 * outage that has not cleared by then is worth putting in front of a person,
 * and `LEASE_SECONDS = 3600` with the keepalive extending it is nowhere near
 * threatened by the wait.
 */
const MAX_ENGINE_ATTEMPTS = 3;
/** First wait between attempts. Doubles from here, so three attempts wait 30s then 60s. */
const ENGINE_RETRY_MS = 30_000;

export type RunnerOptions = {
  url: string;
  engine: Engine;
  /** Travels as `Authorization: Bearer`. The only secret a runner holds between Jobs. */
  token?: string;
  /** First backoff delay after a drop. Doubles from here. */
  reconnectMs?: number;
  /**
   * How long a reconnecting runner keeps trying while its handshake is refused.
   * Here for the same reason `reconnectMs` is: a test cannot wait on the
   * production window.
   */
  refusalPatienceMs?: number;
  /**
   * First wait between engine attempts, doubling. Here for the same reason
   * `reconnectMs` is, and not a CLI flag for the same reason either.
   */
  engineRetryMs?: number;
  /** First wait between attempts at handing the outcome over, doubling. Same reason. */
  completionRetryMs?: number;
  /**
   * How long the runner keeps offering an outcome nobody takes. Here for the
   * same reason `refusalPatienceMs` is: a test about giving up cannot wait out
   * the production window.
   */
  completionPatienceMs?: number;
  runnerId?: string;
  slots?: number;
  stages?: Stage[];
  onEvent?: (jobId: string, event: EngineEvent) => void;
  /** Defaults to JSON lines on stdout. A test passes one that captures instead. */
  log?: Logger;
};

export type RunnerHandle = {
  runnerId: string;
  /** Drops the connection without stopping the runner, which then reconnects. */
  disconnect(): void;
  /** `drain` finishes what is running first; the default closes at once. */
  stop(options?: { drain?: boolean }): Promise<void>;
};

/** A Job being executed, and the batcher whose sequence a reconnect declares. */
type InFlight = {
  controller: AbortController;
  batcher: Batcher;
  /** What is on the remote so far, so a cancellation can say what survived. */
  commits: string[];
};

export async function startRunner(options: RunnerOptions): Promise<RunnerHandle> {
  const { engine } = options;
  const runnerId = options.runnerId ?? `runner_${process.pid}_${Date.now().toString(36)}`;
  const slots = options.slots ?? 1;
  const stages = options.stages ?? ALL_STAGES;
  const log = options.log ?? createLogger("crewbit-runner");
  /**
   * What is in flight, which is exactly what a reconnect has to declare. It
   * outlives any one connection, which is the whole point: a Job survives the
   * socket that delivered it.
   */
  const running = new Map<string, InFlight>();
  /** Set once `stop()` is asked for, and awaited by a second caller. */
  let draining: Promise<void> | undefined;
  const reconnectMs = options.reconnectMs ?? RECONNECT_MS;
  const refusalPatienceMs = options.refusalPatienceMs ?? REFUSAL_PATIENCE_MS;
  const engineRetryMs = options.engineRetryMs ?? ENGINE_RETRY_MS;
  let active = 0;
  let socket: WebSocket;
  let peer: RpcPeer<RunnerCalls, ServerCalls>;
  let stopped = false;
  /** One reconnect chain at a time, and the attempt count it backs off on. */
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let alive: ReturnType<typeof setInterval> | undefined;
  let reconnectAttempt = 0;
  /**
   * When the current run of refused handshakes began, which is what the patience
   * window is measured from. Cleared by a handshake the server accepted, so it
   * is the length of the refusal and not of the runner's life.
   */
  let refusedSince: number | undefined;

  try {
    await connect();
  } catch (cause) {
    // The first connect is the one the caller is told about, and a caller that
    // is handed an error gets no handle: there is nothing left that could call
    // `stop()`. The refused socket's `close` has already scheduled a reconnect
    // by now, and that timer holds the event loop open, so leaving it running
    // would be a chain nobody can cancel in a process nobody can end. A drop
    // after this point is different: the handle exists, and reconnecting is
    // what it is for.
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(alive);
    reconnectTimer = undefined;
    throw cause;
  }

  /**
   * Opens a connection and hands over what this runner still holds. Called
   * again on every drop, so `peer` and `socket` are reassigned rather than
   * captured: everything that sends does so through the current one.
   */
  async function connect(): Promise<void> {
    // Measured: the global WebSocket accepts custom headers in both Bun and
    // Node, even though the browser specification has no such option, so the
    // Bearer handshake needs no query-string fallback.
    socket = options.token
      ? new WebSocket(options.url, {
          headers: { Authorization: `Bearer ${options.token}` },
        } as unknown as string[])
      : new WebSocket(options.url);

    peer = new RpcPeer<RunnerCalls, ServerCalls>({
      send: (frame) => socket.send(frame),
      handlers: {
        // Reply first, work after: a runner that blocks its own accept looks
        // dead to the server.
        "job.assign": (job) => {
          // On the way out. The server was told slots: 0, and this closes the
          // gap between that notification and a Job already in flight toward a
          // runner that is about to stop working.
          if (draining) {
            log.warning("job declined", { job_id: job.jobId, reason: "draining" });
            return { accepted: false, reason: "no_slots" };
          }
          if (!stages.includes(job.stage)) {
            log.warning("job declined", {
              job_id: job.jobId,
              stage: job.stage,
              reason: "unsupported_stage",
              handles: stages,
            });
            return { accepted: false, reason: "unsupported_stage" };
          }
          if (active >= slots) {
            log.warning("job declined", {
              job_id: job.jobId,
              stage: job.stage,
              reason: "no_slots",
              active,
              slots,
            });
            return { accepted: false, reason: "no_slots" };
          }
          active += 1;
          log.info("job accepted", {
            job_id: job.jobId,
            stage: job.stage,
            max_turns: job.harness.maxTurns,
            model: job.harness.model,
            // A Stage told to explore a codebase and handed no checkout runs
            // against an empty directory, which is invisible without this.
            checkout: Boolean(job.repo),
            resuming: Boolean(job.resumeSessionId),
          });
          void execute(job);
          return { accepted: true };
        },
        "job.cancel": (params) => {
          const inFlight = running.get(params.jobId);
          // Not holding it is a success: the server wanted it stopped, and it is.
          if (!inFlight) return { stopped: true, commits: [] };
          log.warning("job cancelled", { job_id: params.jobId, reason: params.reason });
          inFlight.controller.abort();
          // What reached the remote survives the cancellation: work is never
          // discarded on a cancel, only reported back.
          return { stopped: true, commits: inFlight.commits };
        },
      },
      onError: (error) => log.error("protocol error", errorFields(error)),
    });

    const mine = peer;
    socket.addEventListener("message", (event) => mine.receive(String(event.data)));
    socket.addEventListener("close", () => {
      clearInterval(alive);
      mine.close("socket closed");
      if (!stopped) scheduleReconnect();
    });

    await opened(socket);

    const hello = await peer.request("runner.hello", {
      protocol: PROTOCOL_VERSION,
      runnerId,
      version: RUNNER_VERSION,
      engine: { kind: engine.kind, version: engine.version, auth: "subscription" },
      stages,
      slots,
      platform: { os: process.platform, arch: process.arch },
      activeJobs: [...running.entries()].map(([jobId, inFlight]) => ({
        jobId,
        lastSeq: inFlight.batcher.lastSeq(),
      })),
    });

    if (!hello.accepted) {
      refusedSince ??= Date.now();
      socket.close();
      throw new Error(`${REFUSED_HANDSHAKE}: ${hello.reason}`);
    }
    refusedSince = undefined;

    for (const point of hello.resume ?? []) {
      if (point.stillMine) continue;
      // The lease expired while the socket was down and the Job went elsewhere.
      // Another runner may already hold it, and two outcomes for one jobId
      // corrupt the Run, so this one stops and says nothing about it.
      log.warning("job no longer mine, abandoning", { job_id: point.jobId });
      running.get(point.jobId)?.controller.abort();
    }

    reconnectAttempt = 0;
    // "I am still here", and nothing else. A server's runtime may answer an
    // inbound WebSocket ping without waking its code, and offer no way to send
    // one, so the only frame that proves a socket is alive is one the runner
    // sent. A runner mid-Job is already sending
    // `job.status`; this is what an idle one sends instead.
    alive = setInterval(() => {
      peer.notify("runner.alive", {});
    }, hello.heartbeatSeconds * 1000);
    alive.unref?.();

    peer.notify("runner.ready", { slots: slots - active });
    log.info("connected", {
      url: options.url,
      runner_id: runnerId,
      slots,
      stages,
      resuming: running.size,
    });
  }

  /**
   * Backoff, doubling to a ceiling. A server that is down comes back, and a
   * runner hammering it while it does helps nobody.
   *
   * One chain, enforced by the pending timer. A `connect()` that fails both
   * rejects **and** fires `close` on its socket (measured: a refused upgrade
   * fires close, never error), so both paths used to schedule, each of
   * those scheduled two more, and the count doubled every attempt. The attempt
   * counter lives outside for the same reason: the close path called this with no
   * argument, so it reset to zero and the backoff never actually backed off.
   *
   * This timer is deliberately **not** unref'd, unlike the batcher's, the
   * verify timeout's, or the server's heartbeat and sweeper. Those must never be
   * the reason a process lives; this one must be. Once the socket is gone it is
   * the only handle left, so unref'ing it made the runner exit before the first
   * retry fired and every server restart meant restarting the runner by hand.
   * The cost of the inversion is that a caller who never calls `stop()` keeps
   * its own process alive, which is what makes `stop()` clearing the timer
   * load-bearing rather than incidental.
   */
  function scheduleReconnect(): void {
    if (reconnectTimer || stopped) return;
    const delay = Math.min(reconnectMs * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
    // Held here rather than read back below, the way `delay` already is. A
    // failed connect fires `close`, close schedules the next try, and that
    // happens before the rejection reaches the `catch`: reading the counter
    // there reported the attempt after the one whose error it was printing.
    const attempt = reconnectAttempt + 1;
    reconnectAttempt = attempt;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (stopped) return;
      connect().catch((error: Error) => {
        // The one failure that is not worth waiting out forever. Something else
        // is greeted as this runnerId, and if it is not this runner's own ghost
        // the server will keep saying so: a second process on the same id would
        // otherwise dial for the rest of the day, which is the loop the
        // refusal was introduced to avoid rather than to cause.
        if (refusedSince !== undefined && Date.now() - refusedSince >= refusalPatienceMs) {
          log.error("the server keeps refusing this runner", {
            ...errorFields(error),
            runner_id: runnerId,
            patience_ms: refusalPatienceMs,
            holding: running.size,
          });
          void stop();
          return;
        }
        log.warning("reconnecting", {
          ...errorFields(error),
          attempt,
          delay_ms: delay,
        });
        scheduleReconnect();
      });
    }, delay);
  }

  /**
   * Pushes whatever is committed and remembers what landed. Best-effort: this
   * runs on a timer, and the push that decides the outcome is the one at the end.
   */
  async function carry(
    workspace: string,
    repo: NonNullable<JobAssignParams["repo"]>,
    inFlight: InFlight,
  ): Promise<void> {
    if (!(await pushed(workspace, repo)).ok) return;
    inFlight.commits = await commitsSince(workspace);
  }

  /**
   * The end of a writing Job: sweep up, push, and verify against the remote.
   *
   * If commits exist locally and the push did not land, the Job is failed
   * rather than complete: a PR marked ready missing exactly those commits
   * sends the fix loop after a criterion the code already satisfies, forever.
   */
  async function deliver(
    workspace: string,
    repo: NonNullable<JobAssignParams["repo"]>,
    inFlight: InFlight,
    job: JobAssignParams,
  ): Promise<{ commits: string[]; artifacts?: Record<string, string>; problem?: "failed" }> {
    // Whatever the agent edited and did not commit. The prompt reserves turns to
    // do this itself; a run that hit the ceiling mid-change did not get to.
    await commitAll(workspace, `crewbit: work in progress for ${job.stage}`);

    const landed = (await pushed(workspace, repo)).ok;
    const commits = await commitsSince(workspace);
    inFlight.commits = commits;

    if (commits.length === 0) {
      // Nothing to deliver, so nothing to guard. A Stage that wrote only its
      // artifact is a legitimate outcome, and the artifact is not a commit.
      log.info("job produced no commits", { job_id: job.jobId, stage: job.stage });
      return { commits };
    }

    // The remote is read, not the exit code trusted: a push that reports success
    // and leaves the remote behind looks identical from here otherwise. The
    // exit code is logged and decides nothing, because a push can lose a race
    // to the keepalive and still have left the work exactly here.
    const local = await head(workspace);
    const remote = await remoteHead(workspace, repo);
    if (!onRemote(local, remote)) {
      log.error("push did not land, so the job is failed", {
        job_id: job.jobId,
        branch: repo.branch,
        commits: commits.length,
        pushed: landed,
        local_head: local,
        remote_head: remote,
      });
      return {
        commits,
        problem: "failed",
        artifacts: {
          "blocked.md": `${commits.length} commit(s) exist locally and the push to ${repo.branch} did not land. The work is on the runner and not on the remote, so this Job cannot be reported as complete.`,
        },
      };
    }

    log.info("work delivered", {
      job_id: job.jobId,
      branch: repo.branch,
      commits: commits.length,
      head: local,
    });
    return { commits };
  }

  /** Runs the project's own check and reports it the way the server reads it. */
  /**
   * Gets the checkout into a state anything can run in, and reports rather than
   * throwing: an install that failed is a Job that stops, not a runner that did.
   */
  async function prepare(
    job: JobAssignParams,
    workspace: string,
    status: (s: JobStatus, detail?: string) => void,
  ): Promise<{ exitCode: number; report: string } | undefined> {
    const declared = job.harness.prepare;
    if (!declared) return undefined;

    status("preparing", `running ${declared.command}`);
    const result = await runPrepare(declared, workspace);
    log.info("workspace prepared", {
      job_id: job.jobId,
      exit_code: result.exitCode,
      command: declared.command,
    });
    return { exitCode: result.exitCode, report: `exit ${result.exitCode}\n${result.output}` };
  }

  async function verify(
    job: JobAssignParams,
    workspace: string,
    status: (s: JobStatus, detail?: string) => void,
  ): Promise<{ exitCode: number; report: string }> {
    status("working", "running the verify command");
    const result = await runVerify(
      job.harness.verify as { command: string; timeoutSeconds?: number },
      workspace,
    );
    log.info("verify finished", {
      job_id: job.jobId,
      exit_code: result.exitCode,
      command: job.harness.verify?.command,
    });
    // The exit code first, so the server reads a verdict rather than parsing a
    // test runner's prose.
    return { exitCode: result.exitCode, report: `exit ${result.exitCode}\n${result.output}` };
  }

  /**
   * The engine, spawned until it either produces something or runs out of
   * attempts. Only the spawn is repeated: `prepare`, the workspace, `collect`,
   * `deliver` and the outcome decision all run once against the last result, so
   * a Job that exhausts its attempts reports exactly what it reports today.
   *
   * Each attempt is handed the Job's own `resumeSessionId` rather than the
   * failed attempt's. `retryable` only says yes to a run that produced no turns
   * and spent nothing, so there is no session there worth resuming.
   */
  async function runEngine(
    job: JobAssignParams,
    workspace: string,
    controller: AbortController,
    batcher: Batcher,
  ): Promise<EngineResult> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await engine.run({
        prompt: job.harness.prompt,
        cwd: workspace,
        maxTurns: job.harness.maxTurns,
        allowedTools: job.harness.allowedTools,
        permissionMode: job.harness.permissionMode,
        model: job.harness.model,
        maxBudgetUsd: job.harness.maxBudgetUsd,
        resumeSessionId: job.resumeSessionId,
        signal: controller.signal,
        onEvent: (event) => {
          batcher.push(event);
          options.onEvent?.(job.jobId, event);
          // The runner cannot reach a person, having no provider credential.
          // It reports the condition and the server chooses the channel.
          if (event.t === "rate_limit") {
            peer.notify("human.notify", {
              jobId: job.jobId,
              level: "warning",
              code: "rate_limited",
              message: `the ${event.rateLimitType} window is exhausted`,
              resumeAt: new Date(event.resetsAt * 1000).toISOString(),
            });
          }
        },
      });

      if (attempt >= MAX_ENGINE_ATTEMPTS || controller.signal.aborted || !retryable(result)) {
        return result;
      }

      const delay = engineRetryMs * 2 ** (attempt - 1);
      log.warning("the engine hit a transient API error", {
        job_id: job.jobId,
        stage: job.stage,
        attempt,
        attempts: MAX_ENGINE_ATTEMPTS,
        terminal_reason: result.terminalReason,
        api_error_status: result.apiErrorStatus,
        delay_ms: delay,
      });

      // A cancel that lands inside the wait ends the Job here, with the last
      // attempt's result: `execute` discards it on the aborted signal, the way
      // it discards any run the server took back.
      if (!(await waited(delay, controller.signal))) return result;
    }
  }

  async function execute(job: JobAssignParams): Promise<void> {
    const controller = new AbortController();
    let completion: JobCompleteParams;
    const batcher = createBatcher((seq, events) =>
      peer.notify("job.event", { jobId: job.jobId, seq, events }),
    );
    const inFlight: InFlight = { controller, batcher, commits: [] };
    running.set(job.jobId, inFlight);
    const status = (s: JobStatus, detail?: string) => {
      // Flush first, so the transcript the server holds never lags behind the
      // status it would be read against.
      batcher.flush();
      peer.notify("job.status", { jobId: job.jobId, status: s, detail });
    };

    status("preparing");
    // A Stage can outlive its lease, and status is what extends it. Reporting
    // only at transitions would let a long code stage be reclaimed while it is
    // still working, so a keepalive runs for as long as the engine does.
    // The keepalive is also what makes the incremental push a guarantee rather
    // than something the prompt asks for: whatever the agent has committed goes
    // up on the next tick, so being killed late loses one tick and not the Job.
    /**
     * The keepalive push in flight, so the delivery can wait for it rather than
     * race it. Both push the same ref, and git rejects the loser of that race:
     * the delivery losing it against a keepalive carrying an older commit
     * leaves the remote behind and fails a Job that had one tick left to go.
     *
     * `status` keeps ticking through the delivery. Stopping the whole interval
     * here would be simpler and would let the lease lapse under a slow push.
     */
    let carrying: Promise<void> | undefined;
    let delivering = false;
    const keepalive = setInterval(() => {
      status("working");
      if (!job.repo || !delivers(job.stage) || carrying || delivering || !workspace) return;
      carrying = carry(workspace, job.repo, inFlight).finally(() => {
        carrying = undefined;
      });
    }, keepaliveMs(job.leaseSeconds));

    // Declared here so the finally block can clean up whatever was created.
    let workspace = "";

    try {
      // A Stage told to explore a codebase needs the codebase. Cloning is part of
      // preparing, so a clone that fails is a preparing failure and not a Stage
      // that ran against an empty directory.
      //
      // The artifact names travel in `artifacts.collect` rather than in the
      // context, so they have to be handed over separately to be kept out of the
      // commit the way the context already is.
      workspace = await prepareWorkspace({
        context: job.context,
        repo: job.repo,
        artifacts: job.artifacts?.collect ?? [],
        delivers: delivers(job.stage),
        continues: continues(job.stage),
      });
      log.info("workspace ready", {
        job_id: job.jobId,
        path: workspace,
        context_files: Object.keys(job.context ?? {}),
        // The difference between exploring a repository and exploring an empty
        // directory, which look identical from the outside.
        cloned: Boolean(job.repo),
        base_branch: job.repo?.baseBranch,
      });
      // The branch reaches the remote before the engine writes anything, so a
      // runner that dies on its first turn leaves a branch rather than nothing.
      // A Job that cannot push has no way to deliver work, so this is fatal here
      // rather than a surprise at the end.
      //
      // Only for a Stage that delivers. A plan Stage has nothing to put on the
      // remote, and creating its branch here is what left an empty branch behind
      // for a Run a human never approved.
      if (job.repo && delivers(job.stage)) {
        const first = await pushed(workspace, job.repo);
        // A refusal is not yet a failure. The keepalive pushes this same ref,
        // and the loser of that race is refused by git with the work already
        // exactly where this asked for it. So the remote is asked, and only a
        // remote that does not carry the commit — or cannot say — is fatal.
        //
        // What git said travels with it, because this is the first thing that
        // touches the remote: a wrong branch, an expired grant and a repository
        // that is not there all arrive here, and they are three different
        // conversations with the person reading the failure.
        if (!first.ok && !(await alreadyOnRemote(workspace, job.repo))) {
          throw new Error(
            `could not push ${job.repo.branch} before starting: ${first.stderr.trim()}`,
          );
        }
      }
      // Before everything else in the workspace. The code stage was installing
      // dependencies out of its own turn budget, and the eval stage was running
      // its check against a tree with none and calling the result a failed
      // check.
      const prepared = job.harness.prepare ? await prepare(job, workspace, status) : undefined;

      // Before the engine, and never by it. An agent asked to run the tests and
      // report is an agent that can report a green it did not get, which is the
      // fraud the eval stage exists to catch.
      //
      // Only for a Stage that does not deliver. A Stage that writes is the thing
      // that would make a red check green, so running it first and skipping the
      // agent would be refusing to do the Job; its check runs after the push
      // instead, where there is something to check.
      const verified =
        !delivers(job.stage) && (prepared?.exitCode === 0 || !prepared) && job.harness.verify
          ? await verify(job, workspace, status)
          : undefined;

      // A red verify makes the agent's turns pointless, and they are the
      // expensive part. Not a `return`: the completion is sent after this block,
      // and leaving early here left the Job unfinished and the caller waiting.
      // The server reads the exit code and decides what it means; the runner
      // does not know what a verdict is.
      if (prepared && prepared.exitCode !== 0) {
        // Nobody's code is wrong. The workspace could not be made ready, so the
        // Job stops without spending the engine, and it says which command
        // failed rather than leaving the server to read this as a check that
        // ran and said no.
        completion = {
          jobId: job.jobId,
          outcome: "failed",
          artifacts: { "prepare.txt": prepared.report },
        };
      } else if (verified && verified.exitCode !== 0) {
        completion = {
          jobId: job.jobId,
          outcome: "complete",
          artifacts: { "verify.txt": verified.report },
        };
      } else {
        status("working", "workspace ready, engine starting");
        const result = await runEngine(job, workspace, controller, batcher);
        const collected = await collect(workspace, job.artifacts?.collect ?? []);
        // A Stage that explores has nothing to sweep up and nothing to push, so
        // it never reaches for the remote at all.
        delivering = true;
        await carrying;
        const delivered =
          job.repo && delivers(job.stage)
            ? await deliver(workspace, job.repo, inFlight, job)
            : undefined;
        // The other side of the engine, for the Stage that writes. After the
        // push rather than before it, so a red suite still leaves the commits on
        // the remote for the next round to start from.
        const checked =
          job.repo && delivers(job.stage) && job.harness.verify
            ? await verify(job, workspace, status)
            : undefined;
        // One slot on the wire, and only one of the two ever ran.
        const check = verified ?? checked;
        // Why the engine stopped, when it stopped for a reason worth naming.
        // The server has no column for `engineResult`, so it travels as an
        // artifact: a map the server already keeps verbatim.
        const reason = stopReason(result, job.harness.maxTurns);
        // The whole table is in `outcome.ts`, and every branch of it has a test
        // that needs none of this running.
        const { outcome: decided, flipped } = decide({
          problem: delivered?.problem,
          result,
          artifacts: job.artifacts,
          collected,
          checked,
        });
        if (flipped) {
          log.error("the check failed, so the job is failed", {
            job_id: job.jobId,
            stage: job.stage,
            command: job.harness.verify?.command,
            exit_code: checked?.exitCode,
          });
        }
        completion = {
          jobId: job.jobId,
          // The engine's own answer travels alongside whatever it wrote: when a
          // Stage produces nothing, this is what says why.
          artifacts: {
            ...collected,
            // An engine that ran out of turns returns no final answer, and the
            // server's fallback chain does not fall through past `""`, so the
            // note it writes was the empty string. The reason stands in for it.
            "result.md": result.text || reason || "",
            ...(reason ? { "engine.txt": reason } : {}),
            ...(check ? { "verify.txt": check.report } : {}),
            // `blocked.md` is the file the server reads for the note it puts on
            // the Run, so this is what puts the failure in front of a person
            // rather than leaving it in an artifact nobody opens.
            ...(flipped && checked
              ? {
                  "blocked.md": `\`${job.harness.verify?.command}\` did not pass, so this change is not finished. The commits are on ${job.repo?.branch} and the check said:\n\n${checked.report}`,
                }
              : {}),
            ...delivered?.artifacts,
          },
          commits: delivered?.commits,
          outcome: flipped ? "failed" : decided,
          session: {
            id: result.sessionId,
            turns: result.turns,
            costUsd: result.costUsd,
            durationMs: 0,
          },
          engineResult: { subtype: result.subtype, terminalReason: result.terminalReason },
        };
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("job failed", { job_id: job.jobId, stage: job.stage, ...errorFields(cause) });
      completion = {
        jobId: job.jobId,
        outcome: "failed",
        artifacts: { "error.txt": message },
      };
    } finally {
      clearInterval(keepalive);
      // Sends the tail before the outcome, so the transcript explains it.
      batcher.stop();
    }

    let taken = false;
    /**
     * Read before the handover rather than after it, because the two aborts mean
     * opposite things about the workspace. One that had already fired is the
     * server taking the Job back, and whoever holds it now will produce the
     * artifacts again. One that fires *during* the handover is this runner being
     * stopped, and then these are the only copy there is.
     */
    const cancelled = controller.signal.aborted;

    // A cancelled Job belongs to the server again, and it may already be
    // assigned elsewhere. Reporting an outcome now would be applied, because a
    // requeued Job is not `done`, and the Run would carry a result from a
    // runner that was told to stop.
    if (!cancelled) {
      status("finalizing");
      taken = await reportCompletion({
        jobId: job.jobId,
        send: () => peer.request("job.complete", completion),
        signal: controller.signal,
        log,
        retryMs: options.completionRetryMs,
        patienceMs: options.completionPatienceMs,
      });
    }

    // The workspace survives until the server has the artifacts, which is what
    // the line here used to promise while deleting them anyway. Work nobody
    // recorded has no other copy: a code stage's commits are at least on the
    // remote, and a plan stage's `plan.md` is here or nowhere.
    if (taken || cancelled) {
      await rm(workspace, { recursive: true, force: true });
    } else {
      log.error("the workspace was kept, because nothing recorded the work in it", {
        job_id: job.jobId,
        stage: job.stage,
        path: workspace,
      });
    }

    /**
     * Held until here, rather than dropped the moment the engine stopped, which
     * is what makes the handover survivable: a Job already out of `running` is
     * one `drain` does not wait for, a reconnect does not declare in
     * `activeJobs`, and a `job.cancel` cannot reach.
     *
     * The slot goes back with it, and not before. Freeing it while the outcome
     * is unrecorded is how a runner took new work holding a Job the store still
     * said was assigned to it.
     */
    running.delete(job.jobId);
    active -= 1;
    peer.notify("runner.ready", { slots: slots - active });
  }

  /**
   * Stops taking work, lets what is running finish, then closes.
   *
   * Closing at once cost everything the engine had not pushed, which is up to
   * a third of the lease: twenty minutes by default, because that is when the
   * keepalive next carries the commits up. The Job itself survives either way,
   * since the server reclaims it, but the turns spent on it do not.
   *
   * Idempotent, because a second Ctrl-C is a person asking again rather than a
   * second drain to wait for. What it is not is a way to give up faster: the
   * signal handler owns that, and it owns it by exiting.
   *
   * Named rather than written into the handle, because the reconnect chain ends
   * itself through it when the server will not have this runner: two ways to
   * stop is how one of them stops clearing the timer.
   */
  async function stop(how: { drain?: boolean } = {}): Promise<void> {
    if (draining) return draining;
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(alive);
    reconnectTimer = undefined;

    // Closing at once is the default, and it is what every caller but the
    // signal handler wants: a test tearing a runner down, a supervisor that
    // has already decided. Draining is asked for, because waiting on an
    // engine that may never finish is a choice with a cost.
    if (!how.drain || running.size === 0) {
      // Including whatever is mid-handover. Nothing reconnects after this, so
      // every attempt left to make would be against a peer that is closed for
      // good, and the waits between them are timers holding a process open that
      // somebody has asked to end.
      for (const inFlight of running.values()) inFlight.controller.abort();
      peer.close("runner stopped");
      socket.close();
      return;
    }

    // Before waiting, so the server stops dispatching here while what is in
    // hand finishes. `pickFor` skips a connection with no free slot.
    peer.notify("runner.ready", { slots: 0 });
    log.info("runner draining", { holding: running.size });

    draining = (async () => {
      while (running.size > 0) await new Promise((tick) => setTimeout(tick, 50));
      peer.close("runner stopped");
      socket.close();
    })();
    return draining;
  }

  return {
    runnerId,
    disconnect: () => socket.close(),
    stop,
  };
}

/**
 * Reads back the files the Job asked for. A declared file the agent did not write
 * is simply absent, and nothing undeclared is ever returned: a stray scratch file
 * must not become something the server publishes.
 */
async function collect(workspace: string, names: string[]): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  for (const name of names) {
    const target = resolve(workspace, name);
    if (target !== workspace && !target.startsWith(workspace + sep)) continue;
    try {
      found[name] = await readFile(target, "utf8");
    } catch {
      /* not written */
    }
  }

  return found;
}

/**
 * Applies the server's table without knowing what any of it means. Ordered, so
 * refusals listed before success win when an agent hedged by writing both.
 */
/**
 * Comfortably inside the lease, so one dropped notification does not cost the
 * claim. A third of the window means two would have to be missed in a row.
 */
function keepaliveMs(leaseSeconds = 3600): number {
  return Math.max(200, Math.floor((leaseSeconds * 1000) / 3));
}

function opened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((fulfil, reject) => {
    const fail = () => reject(new Error(`could not connect to ${socket.url}`));
    socket.addEventListener("open", () => fulfil(), { once: true });
    socket.addEventListener("error", fail, { once: true });
    // Measured: a refused upgrade (a 401 from the server) fires `close` and
    // never `error`, so waiting on `error` alone hangs forever instead of
    // reporting that the token was rejected.
    socket.addEventListener("close", fail, { once: true });
  });
}
