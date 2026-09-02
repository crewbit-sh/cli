/**
 * The server half of the runner protocol, and nothing else: no core, no
 * dispatch, no store, no provider. A contributor to this repository starts
 * one, points the real runner at its `url`, and drives a Job through it to
 * prove the wire without the harness that pulls in a whole other package.
 *
 * One runner connection at a time, and `resumeWith` scripts whatever a test
 * wants a reconnect to be told — that is what lets the runner's own reconnect
 * behaviour (declaring `activeJobs`, reacting to `stillMine`, resuming the
 * batcher from an acked seq) be driven without this double deciding it for
 * real. Deciding it for real is what stays out of scope: whether a lease has
 * actually expired, a grace window, fairness across multiple runners. That is
 * server behaviour with its own coverage on the server, and reimplementing
 * it here would make this a second server rather than a double.
 */
import { createServer, type Server } from "node:http";
import {
  type CancelReason,
  type HelloResult,
  type HumanNotifyParams,
  type JobAssignParams,
  type JobAssignResult,
  type JobCancelResult,
  type JobCompleteParams,
  type JobEvent,
  type JobEventParams,
  type JobStatusParams,
  PROTOCOL_VERSION,
  RpcPeer,
  type RunnerCalls,
  type ServerCalls,
} from "@crewbit/protocol";
import { type WebSocket as Socket, WebSocketServer } from "ws";

export type ServerDoubleOptions = {
  /** A fixed port, for a test that restarts on the same one. Defaults to an ephemeral one. */
  port?: number;
  heartbeatSeconds?: number;
};

export type ServerDouble = {
  /** Where a runner dials: `ws://127.0.0.1:<port>/runner/v1`. */
  url: string;
  /** Resolves with the connected runner's own handshake. */
  helloReceived(): Promise<RunnerCalls["runner.hello"]["params"]>;
  /** Every handshake this double has received, oldest first: a reconnect is a second one. */
  hellos(): RunnerCalls["runner.hello"]["params"][];
  /** Resolves once at least `count` handshakes have arrived. */
  waitForHello(count: number): Promise<void>;
  /**
   * What the next handshake declaring this Job in `activeJobs` is told about
   * it. Set before the reconnect that is expected to ask.
   */
  resumeWith(jobId: string, point: { ackedSeq: number; stillMine: boolean }): void;
  /** Drops the current connection without stopping the double, so the runner reconnects. */
  disconnectRunner(): void;
  assign(params: JobAssignParams): Promise<JobAssignResult>;
  /**
   * Every `runner.ready` the runner announced, oldest first. The runner sends
   * one when it connects and one as each Job leaves its hands, so the second
   * is what says a Job is finished with, however it ended.
   */
  readies(): RunnerCalls["runner.ready"]["params"][];
  /** Resolves once at least `count` of them have arrived. */
  waitForReady(count: number): Promise<void>;
  /**
   * How many `runner.alive` beats have arrived. The payload is empty: the
   * frame itself is the whole message, which is why this is a count.
   */
  aliveCount(): number;
  /** Resolves once at least `count` beats have arrived. */
  waitForAlive(count: number): Promise<void>;
  cancel(jobId: string, reason: CancelReason): Promise<JobCancelResult>;
  statuses(jobId: string): JobStatusParams[];
  /** Every event the runner sent for the Job, in order, with the batching flattened away. */
  events(jobId: string): JobEvent[];
  /**
   * The `job.event` frames themselves, which is what a test about batching
   * reads: one frame per flush, carrying the sequence the runner assigned it.
   */
  batches(jobId: string): JobEventParams[];
  notifications(): HumanNotifyParams[];
  /** Resolves with the Job's completion, once the runner sends it. */
  completionFor(jobId: string): Promise<JobCompleteParams>;
  /**
   * Makes the next `times` `job.complete` requests for this Job reject,
   * simulating the store failure this protocol never sees directly: what a
   * runner does about a completion nobody could take. Pass `"always"` for a
   * store that never recovers.
   */
  refuseCompletion(jobId: string, times: number | "always"): void;
  /** How many `job.complete` requests have arrived for this Job, refused or not. */
  completionAttempts(jobId: string): number;
  /** Resolves once at least `count` events have arrived for the Job. */
  waitForEvent(jobId: string, count: number): Promise<void>;
  /** Resolves once at least `count` `job.status` notifications have arrived for the Job. */
  waitForStatus(jobId: string, count: number): Promise<void>;
  waitForNotification(jobId: string): Promise<void>;
  stop(): Promise<void>;
};

const DEFAULT_HEARTBEAT_SECONDS = 30;

export async function startServerDouble(options: ServerDoubleOptions = {}): Promise<ServerDouble> {
  const heartbeatSeconds = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  const statuses = new Map<string, JobStatusParams[]>();
  const events = new Map<string, JobEvent[]>();
  const batches = new Map<string, JobEventParams[]>();
  const notifications: HumanNotifyParams[] = [];
  const readyLog: RunnerCalls["runner.ready"]["params"][] = [];
  let beats = 0;
  const completions = new Map<string, (params: JobCompleteParams) => void>();
  const pendingCompletions = new Map<string, JobCompleteParams>();
  const completionRefusals = new Map<string, number>();
  const completionAttemptCounts = new Map<string, number>();
  const waiters: Array<() => void> = [];

  let peer: RpcPeer<ServerCalls, RunnerCalls> | undefined;
  let currentSocket: Socket | undefined;
  const helloLog: RunnerCalls["runner.hello"]["params"][] = [];
  const resumePoints = new Map<string, { ackedSeq: number; stillMine: boolean }>();
  let helloResolve: ((params: RunnerCalls["runner.hello"]["params"]) => void) | undefined;
  const helloPromise = new Promise<RunnerCalls["runner.hello"]["params"]>((resolve) => {
    helloResolve = resolve;
  });

  const wss = new WebSocketServer({ noServer: true });
  const http: Server = createServer((_request, response) => {
    response.writeHead(404).end("this double speaks websocket at /runner/v1 only");
  });

  http.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/runner/v1") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => attach(ws));
  });

  function attach(socket: Socket): void {
    currentSocket = socket;
    const mine: RpcPeer<ServerCalls, RunnerCalls> = new RpcPeer<ServerCalls, RunnerCalls>({
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      },
      handlers: {
        "runner.hello": (params) => {
          helloResolve?.(params);
          helloLog.push(params);
          settleWaiters();
          if (params.protocol !== PROTOCOL_VERSION) {
            const refusal: HelloResult = {
              accepted: false,
              reason: `this double speaks ${PROTOCOL_VERSION}`,
            };
            // setTimeout, not queueMicrotask: queueMicrotask looks cleaner
            // and was tried first, but it queues ahead of the `await`
            // continuation that writes this very response, so the socket
            // closed before the refusal ever reached the wire and the
            // caller's request hung forever. A macrotask always runs after
            // the microtask queue drains, so the write is guaranteed first.
            setTimeout(() => socket.close(), 0);
            return refusal;
          }
          const resume = (params.activeJobs ?? []).flatMap((job) => {
            const point = resumePoints.get(job.jobId);
            return point ? [{ jobId: job.jobId, ...point }] : [];
          });
          return {
            accepted: true,
            serverVersion: "double-0.0.0",
            heartbeatSeconds,
            maxJobBytes: 1_048_576,
            ...(resume.length ? { resume } : {}),
          };
        },
        "runner.ready": (params) => {
          readyLog.push(params);
          settleWaiters();
        },
        "runner.alive": () => {
          beats += 1;
          settleWaiters();
        },
        "job.status": (params) => {
          const list = statuses.get(params.jobId) ?? [];
          list.push(params);
          statuses.set(params.jobId, list);
          settleWaiters();
        },
        "job.event": (params) => {
          const list = events.get(params.jobId) ?? [];
          list.push(...params.events);
          events.set(params.jobId, list);
          const frames = batches.get(params.jobId) ?? [];
          frames.push(params);
          batches.set(params.jobId, frames);
          settleWaiters();
        },
        "human.notify": (params) => {
          notifications.push(params);
          settleWaiters();
        },
        "job.complete": (params) => {
          completionAttemptCounts.set(
            params.jobId,
            (completionAttemptCounts.get(params.jobId) ?? 0) + 1,
          );
          const remaining = completionRefusals.get(params.jobId) ?? 0;
          if (remaining > 0) {
            completionRefusals.set(params.jobId, remaining - 1);
            throw new Error("the double refused this completion");
          }
          const waiting = completions.get(params.jobId);
          if (waiting) waiting(params);
          else pendingCompletions.set(params.jobId, params);
          return { acknowledged: true };
        },
      },
    });
    peer = mine;
    // `mine`, not the outer `peer`, in both listeners below. A second
    // connection can attach and reassign `peer` before this socket's own
    // "close" (or a straggling "message") fires, and a listener reaching for
    // shared connection state at that point acts on whichever connection is
    // current rather than the one that actually raised the event.
    //
    // This is a family, not a one-off: the service's own fake runner had
    // the same shape from the other direction, a handler
    // closing over a `const` its own enclosing call had not finished
    // assigning yet, because a message can arrive before the promise that
    // sets it up resolves. Both are a listener trusting shared, mutable,
    // connection-scoped state instead of the specific connection it was
    // registered for. Measured here: this is what made a test connecting
    // twice in a row hang, because the first socket's late close cleared the
    // second connection's peer. Look for this shape again before writing the
    // next socket adapter in this project.
    socket.on("message", (data) => mine.receive(String(data)));
    socket.on("close", () => {
      if (peer === mine) peer = undefined;
    });
  }

  function settleWaiters(): void {
    const ready = [...waiters];
    waiters.length = 0;
    for (const resolve of ready) resolve();
  }

  const port = await new Promise<number>((resolve) => {
    http.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = http.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  function connectedPeer(): RpcPeer<ServerCalls, RunnerCalls> {
    if (!peer) throw new Error("no runner is connected to this double");
    return peer;
  }

  return {
    url: `ws://127.0.0.1:${port}/runner/v1`,
    helloReceived: () => helloPromise,
    hellos: () => [...helloLog],
    waitForHello: (count) =>
      new Promise((resolve) => {
        const check = () => helloLog.length >= count;
        if (check()) {
          resolve();
          return;
        }
        const wait = () => (check() ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
    resumeWith: (jobId, point) => {
      resumePoints.set(jobId, point);
    },
    disconnectRunner: () => currentSocket?.terminate(),
    assign: (params) => connectedPeer().request("job.assign", params),
    aliveCount: () => beats,
    waitForAlive: (count) =>
      new Promise((resolve) => {
        const check = () => beats >= count;
        if (check()) {
          resolve();
          return;
        }
        const wait = () => (check() ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
    readies: () => [...readyLog],
    waitForReady: (count) =>
      new Promise((resolve) => {
        const check = () => readyLog.length >= count;
        if (check()) {
          resolve();
          return;
        }
        const wait = () => (check() ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
    cancel: (jobId, reason) => connectedPeer().request("job.cancel", { jobId, reason }),
    statuses: (jobId) => statuses.get(jobId) ?? [],
    events: (jobId) => events.get(jobId) ?? [],
    batches: (jobId) => batches.get(jobId) ?? [],
    notifications: () => [...notifications],
    completionFor: (jobId) =>
      new Promise((resolve) => {
        const pending = pendingCompletions.get(jobId);
        if (pending) {
          pendingCompletions.delete(jobId);
          resolve(pending);
          return;
        }
        completions.set(jobId, resolve);
      }),
    refuseCompletion: (jobId, times) => {
      completionRefusals.set(jobId, times === "always" ? Number.POSITIVE_INFINITY : times);
    },
    completionAttempts: (jobId) => completionAttemptCounts.get(jobId) ?? 0,
    waitForEvent: (jobId, count) =>
      new Promise((resolve) => {
        const check = () => (events.get(jobId)?.length ?? 0) >= count;
        if (check()) {
          resolve();
          return;
        }
        const wait = () => (check() ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
    waitForStatus: (jobId, count) =>
      new Promise((resolve) => {
        const check = () => (statuses.get(jobId)?.length ?? 0) >= count;
        if (check()) {
          resolve();
          return;
        }
        const wait = () => (check() ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
    waitForNotification: (jobId) =>
      new Promise((resolve) => {
        const check = () => notifications.some((n) => n.jobId === jobId);
        if (check()) {
          resolve();
          return;
        }
        const wait = () => (check() ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
    async stop() {
      for (const client of wss.clients) client.terminate();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
