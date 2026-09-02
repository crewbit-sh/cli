import { describe, expect, test } from "bun:test";
import { createLogger, type Logger } from "../log.ts";
import { backoff, MAX_RETRY_MS, reportCompletion } from "./completion.ts";

type Line = { message: string; status: string } & Record<string, unknown>;

function reading(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  return { log: createLogger("test", (line) => lines.push(JSON.parse(line))), lines };
}

/** A `send` that fails the first `failures` times and then succeeds. */
function failing(failures: number) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    send: async () => {
      calls += 1;
      if (calls <= failures) throw new Error(`refused on attempt ${calls}`);
      return { acknowledged: true };
    },
  };
}

const never = () => new AbortController().signal;

describe("a completion the server takes", () => {
  test("is sent once, and nothing is retried", async () => {
    const server = failing(0);
    const { log, lines } = reading();

    const taken = await reportCompletion({
      jobId: "job_1",
      send: server.send,
      signal: never(),
      log,
    });

    expect(taken).toBe(true);
    expect(server.calls).toBe(1);
    expect(lines).toEqual([]);
  });
});

describe("a completion the server refuses", () => {
  test("is offered again, and the second answer is the one that counts", async () => {
    const server = failing(1);
    const { log, lines } = reading();

    const taken = await reportCompletion({
      jobId: "job_2",
      send: server.send,
      signal: never(),
      log,
      retryMs: 1,
    });

    expect(taken).toBe(true);
    expect(server.calls).toBe(2);
    // The retry that saved the Job says so, or working is indistinguishable
    // from never having failed.
    expect(lines.at(-1)).toMatchObject({ message: "the completion was taken", attempt: 2 });
  });

  test("says which attempt it is on and how long it is waiting", async () => {
    const server = failing(2);
    const { log, lines } = reading();

    await reportCompletion({
      jobId: "job_3",
      send: server.send,
      signal: never(),
      log,
      retryMs: 1,
    });

    const lost = lines.filter((line) => line.message === "completion was not acknowledged");
    expect(lost).toHaveLength(2);
    expect(lost[0]).toMatchObject({ job_id: "job_3", attempt: 1, status: "warning" });
    expect(lost[0]?.["error.message"]).toBe("refused on attempt 1");
    expect(Number(lost[1]?.delay_ms)).toBeGreaterThan(Number(lost[0]?.delay_ms));
  });

  test("gives up inside its patience, and says the work was never taken", async () => {
    const server = failing(Number.POSITIVE_INFINITY);
    const { log, lines } = reading();

    const taken = await reportCompletion({
      jobId: "job_4",
      send: server.send,
      signal: never(),
      log,
      retryMs: 1,
      patienceMs: 50,
    });

    expect(taken).toBe(false);
    // Not one attempt, which is the whole defect, and not forever either.
    expect(server.calls).toBeGreaterThan(1);
    expect(lines.at(-1)).toMatchObject({
      message: "the completion was never acknowledged",
      job_id: "job_4",
      status: "error",
    });
    expect(Number(lines.at(-1)?.attempts)).toBe(server.calls);
  });
});

describe("a Job that stopped being this runner's to report on", () => {
  /**
   * Long enough that passing is proof: a wait that ignored the signal rather
   * than clearing its timer would sit here until vitest gave up.
   */
  const LONG_WAIT = 60_000;

  test("is abandoned mid-wait, rather than offered again", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { log, lines } = reading();

    const taken = await reportCompletion({
      jobId: "job_5",
      send: async () => {
        calls += 1;
        controller.abort();
        throw new Error("the socket went away");
      },
      signal: controller.signal,
      log,
      retryMs: LONG_WAIT,
    });

    expect(taken).toBe(false);
    expect(calls).toBe(1);
    // Abandoned is not the same as never taken: nothing is lost here, because
    // whoever holds the Job now will report it.
    expect(lines.some((line) => line.message === "the completion was never acknowledged")).toBe(
      false,
    );
    // And nothing announces a wait it is not going to take. This line was
    // written on the way out of a stopping runner, saying it would try again in
    // a second, and it never tried: an operator reads that as a retry that
    // happened.
    expect(lines.some((line) => line.message === "completion was not acknowledged")).toBe(false);
  });

  test("is not offered at all when it was taken back before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = failing(0);

    const taken = await reportCompletion({
      jobId: "job_6",
      send: server.send,
      signal: controller.signal,
      log: reading().log,
    });

    expect(taken).toBe(false);
    expect(server.calls).toBe(0);
  });
});

describe("the wait between attempts", () => {
  test("doubles, so a server that is down is not hammered", () => {
    expect(backoff(1, 1_000)).toBe(1_000);
    expect(backoff(2, 1_000)).toBe(2_000);
    expect(backoff(3, 1_000)).toBe(4_000);
  });

  test("stops at a ceiling, so patience is spent on attempts rather than on one wait", () => {
    expect(backoff(20, 1_000)).toBe(MAX_RETRY_MS);
    // The doubling overflows to Infinity long before this, and a ceiling that
    // let it through would wait out the patience in a single sleep.
    expect(backoff(2_000, 1_000)).toBe(MAX_RETRY_MS);
  });
});
