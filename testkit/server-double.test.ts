/**
 * The double speaks only the protocol: no core, no dispatch, no store. A
 * contributor to this repository uses it to prove the runner's half of the
 * wire without the 274 integration tests that reach a real server through a
 * harness this package cannot pull in.
 *
 * The runner side here is a minimal peer written by hand, not `startRunner`
 * from `../src/index.ts`: these tests are about what the double itself does,
 * and pulling the real runner in would make a failure here ambiguous between
 * "the double is wrong" and "the runner is wrong".
 */
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  RpcPeer,
  type RunnerCalls,
  type ServerCalls,
} from "@crewbit/protocol";
import { afterEach, describe, expect, test } from "bun:test";
import { startServerDouble } from "./server-double.ts";

type FakeRunner = {
  peer: RpcPeer<RunnerCalls, ServerCalls>;
  socket: WebSocket;
  close(): void;
};

let sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

function connectFakeRunner(
  url: string,
  handlers: Partial<{
    "job.assign": (params: ServerCalls["job.assign"]["params"]) => ServerCalls["job.assign"]["result"];
    "job.cancel": (params: ServerCalls["job.cancel"]["params"]) => ServerCalls["job.cancel"]["result"];
  }> = {},
): Promise<FakeRunner> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const peer = new RpcPeer<RunnerCalls, ServerCalls>({
    send: (frame) => socket.send(frame),
    handlers: {
      "job.assign": handlers["job.assign"] ?? (() => ({ accepted: true })),
      "job.cancel": handlers["job.cancel"] ?? (() => ({ stopped: true, commits: [] })),
    },
  });
  socket.on("message", (data) => peer.receive(String(data)));
  socket.on("close", () => peer.close("socket closed"));

  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ peer, socket, close: () => socket.close() }));
    socket.once("error", reject);
  });
}

async function hello(
  runner: FakeRunner,
  overrides: Partial<RunnerCalls["runner.hello"]["params"]> = {},
) {
  return runner.peer.request("runner.hello", {
    protocol: PROTOCOL_VERSION,
    runnerId: "runner-1",
    version: "0.0.0",
    engine: { kind: "test", version: "0.0.0", auth: "subscription" },
    stages: ["plan", "code", "pr", "eval"],
    slots: 1,
    platform: { os: "test", arch: "test" },
    ...overrides,
  });
}

describe("the handshake", () => {
  test("a runner declaring the served protocol version is accepted", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);

    const result = await hello(runner);

    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.heartbeatSeconds).toBeGreaterThan(0);
    await double.stop();
  });

  test("a runner declaring a version this double does not speak is refused", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);

    const result = await hello(runner, { protocol: "v99" as typeof PROTOCOL_VERSION });

    expect(result).toEqual({ accepted: false, reason: expect.any(String) });
    await double.stop();
  });
});

describe("assigning a job", () => {
  test("resolves with what the connected runner replied", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url, {
      "job.assign": () => ({ accepted: true }),
    });
    await hello(runner);

    const result = await double.assign({
      jobId: "job-1",
      runId: "run-1",
      stage: "code",
      context: {},
      harness: { prompt: "do the thing", maxTurns: 10 },
    });

    expect(result).toEqual({ accepted: true });
    await double.stop();
  });

  test("a decline is reported as-is, not as an error", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url, {
      "job.assign": () => ({ accepted: false, reason: "no_slots" }),
    });
    await hello(runner);

    const result = await double.assign({
      jobId: "job-2",
      runId: "run-1",
      stage: "code",
      context: {},
      harness: { prompt: "do the thing", maxTurns: 10 },
    });

    expect(result).toEqual({ accepted: false, reason: "no_slots" });
    await double.stop();
  });
});

describe("what a runner reports mid-job", () => {
  test("job.status and job.event are recorded in the order they arrived", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);
    await hello(runner);

    runner.peer.notify("job.status", { jobId: "job-3", status: "working" });
    runner.peer.notify("job.event", {
      jobId: "job-3",
      seq: 1,
      events: [{ t: "assistant", text: "writing the failing test first" }],
    });

    await double.waitForEvent("job-3", 1);
    await double.waitForStatus("job-3", 1);

    expect(double.statuses("job-3")).toEqual([{ jobId: "job-3", status: "working" }]);
    expect(double.events("job-3")).toEqual([{ t: "assistant", text: "writing the failing test first" }]);
    await double.stop();
  });

  test("human.notify is recorded", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);
    await hello(runner);

    runner.peer.notify("human.notify", {
      jobId: "job-4",
      level: "warning",
      code: "rate_limited",
      message: "the five_hour window is exhausted",
    });

    await double.waitForNotification("job-4");

    expect(double.notifications()).toEqual([
      {
        jobId: "job-4",
        level: "warning",
        code: "rate_limited",
        message: "the five_hour window is exhausted",
      },
    ]);
    await double.stop();
  });
});

describe("completing a job", () => {
  test("resolves completionFor and acknowledges the runner", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);
    await hello(runner);

    const completed = double.completionFor("job-5");
    const acked = await runner.peer.request("job.complete", {
      jobId: "job-5",
      outcome: "complete",
      artifacts: { "result.md": "done" },
    });

    expect(acked).toEqual({ acknowledged: true });
    await expect(completed).resolves.toEqual({
      jobId: "job-5",
      outcome: "complete",
      artifacts: { "result.md": "done" },
    });
    await double.stop();
  });

  test("refuseCompletion makes the runner's request reject, N times before it accepts", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);
    await hello(runner);
    double.refuseCompletion("job-9", 1);

    const completed = double.completionFor("job-9");
    await expect(
      runner.peer.request("job.complete", {
        jobId: "job-9",
        outcome: "complete",
        artifacts: {},
      }),
    ).rejects.toThrow();
    const acked = await runner.peer.request("job.complete", {
      jobId: "job-9",
      outcome: "complete",
      artifacts: {},
    });

    expect(acked).toEqual({ acknowledged: true });
    await expect(completed).resolves.toMatchObject({ jobId: "job-9" });
    expect(double.completionAttempts("job-9")).toBe(2);
    await double.stop();
  });
});

describe("cancelling a job", () => {
  test("the runner's reply reaches the caller", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url, {
      "job.cancel": () => ({ stopped: true, commits: ["a1b2c3d"] }),
    });
    await hello(runner);

    const result = await double.cancel("job-6", "user_cancelled");

    expect(result).toEqual({ stopped: true, commits: ["a1b2c3d"] });
    await double.stop();
  });
});

describe("what a reconnect needs scriptable", () => {
  test("every handshake is kept, in order, not just the first", async () => {
    const double = await startServerDouble();
    const first = await connectFakeRunner(double.url);
    await hello(first, { runnerId: "runner-a" });
    first.close();

    const second = await connectFakeRunner(double.url);
    await hello(second, { runnerId: "runner-a", activeJobs: [{ jobId: "job-7", lastSeq: 3 }] });

    await double.waitForHello(2);
    expect(double.hellos().map((h) => h.runnerId)).toEqual(["runner-a", "runner-a"]);
    expect(double.hellos()[1]?.activeJobs).toEqual([{ jobId: "job-7", lastSeq: 3 }]);
    await double.stop();
  });

  test("resumeWith puts that point on the next hello's answer", async () => {
    const double = await startServerDouble();
    double.resumeWith("job-8", { ackedSeq: 5, stillMine: true });
    const runner = await connectFakeRunner(double.url);

    const result = await hello(runner, { activeJobs: [{ jobId: "job-8", lastSeq: 5 }] });

    expect(result).toMatchObject({
      accepted: true,
      resume: [{ jobId: "job-8", ackedSeq: 5, stillMine: true }],
    });
    await double.stop();
  });

  test("disconnectRunner drops the connection without the double stopping", async () => {
    const double = await startServerDouble();
    const runner = await connectFakeRunner(double.url);
    await hello(runner);
    const closed = new Promise<void>((resolve) => runner.socket.once("close", resolve));

    double.disconnectRunner();

    await closed;
    await double.stop();
  });
});
