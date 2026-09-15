/**
 * The Copilot engine end to end: a real `startRunner` over a real socket to the
 * server double, with a stand-in for the binary that replays
 * `fixtures/copilot-ok.jsonl`.
 *
 * The unit tests beside `src/runner/engine/` carry the branches. This is the
 * other job: the two halves that each work and do not fit. What it proves is
 * everything that only exists once the pieces are assembled - the handshake the
 * server is told, the transcript it receives, the completion it is sent, and
 * that the prompt reached the engine over stdin rather than argv.
 *
 * The stand-in rather than `copilot` itself, because the recording is what a
 * real run produced and a suite that needs a Copilot seat is a suite nobody
 * else can run.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotCliEngine, startRunner } from "../src/index.ts";
import { integrationHarness } from "./support/harness.ts";

const { quiet, stopAll, server } = integrationHarness();

const FIXTURE = new URL("../fixtures/copilot-ok.jsonl", import.meta.url).pathname;

/** What the stand-in recorded about the call the runner made. */
type Probe = { argv: () => string[]; stdin: () => string; env: () => Record<string, string> };

/**
 * Stands in for `copilot`: records its argv, its stdin and its environment,
 * then prints the recording on stdout the way the real binary would.
 */
function copilotStandIn(): { binary: string; probe: Probe } {
  const dir = mkdtempSync(join(tmpdir(), "crewbit-copilot-flow-"));
  const binary = join(dir, "copilot.sh");
  writeFileSync(
    binary,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> '${dir}/argv.txt'; done
env > '${dir}/env.txt'
cat > '${dir}/stdin.txt'
cat '${FIXTURE}'
`,
  );
  chmodSync(binary, 0o755);

  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  return {
    binary,
    probe: {
      argv: () => read("argv.txt").split("\n").filter(Boolean),
      stdin: () => read("stdin.txt"),
      env: () =>
        Object.fromEntries(
          read("env.txt")
            .split("\n")
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        ),
    },
  };
}

/**
 * The runner's own environment for the length of one test. `startRunner` reads
 * `process.env` when it spawns, and there is no seam between here and there:
 * what the operator's shell carries is the input this engine's isolation is
 * about.
 */
function withEnv(vars: Record<string, string>): { restore: () => void } {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  return {
    restore: () => {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const job = (jobId: string, prompt: string) => ({
  jobId,
  runId: "run-1",
  stage: "plan" as const,
  context: {},
  harness: { prompt },
});

/** Runs one Job through a real runner and hands back both sides of it. */
async function ran(jobId: string, prompt = "read probe.ts and say what GREETING is") {
  const { binary, probe } = copilotStandIn();
  const double = await server();
  const runner = await startRunner({
    url: double.url,
    engine: copilotCliEngine({ binary, version: "1.0.83" }),
    log: quiet,
  });
  stopAll.push(() => runner.stop());

  const hello = await double.helloReceived();
  await double.assign(job(jobId, prompt));
  const completion = await double.completionFor(jobId);
  return { double, hello, completion, probe };
}

describe("a Job run by the Copilot engine", () => {
  test("tells the server which engine ran it, and which version of it", async () => {
    const { hello } = await ran("job-1");

    // Not `"unknown"`: the handshake is where an operator finds out what is
    // actually installed on the machine that took their Job.
    expect(hello.engine).toMatchObject({
      kind: "copilot-cli",
      version: "1.0.83",
      auth: "subscription",
    });
  });

  test("reports what the engine answered, and the session the result line named", async () => {
    const { completion } = await ran("job-2");

    expect(completion.outcome).toBe("complete");
    expect(completion.artifacts?.["result.md"]).toBe("hello from probe");
    expect(completion.session?.id).toBe("56162319-f6d2-42a3-9f42-37e397dc3740");
    expect(completion.session?.turns).toBe(2);
  });

  test("bills the Job for the credits the run reported, not for nothing", async () => {
    const { completion } = await ran("job-3");

    // 274,608,000 nanoAIU at $0.01 the credit. A costUsd of 0 on a run that
    // spent something is the failure this asserts against.
    expect(completion.session?.costUsd).toBeCloseTo(0.0027, 4);
    expect(completion.session?.costUsd).toBeGreaterThan(0);
  });

  test("the transcript reaches the server as the tool call and the answer", async () => {
    const { double } = await ran("job-4");

    const events = double.events("job-4");
    expect(events.map((e) => e.t)).toEqual(["tool_use", "assistant"]);
    expect(events[0]).toMatchObject({ t: "tool_use", name: "view" });
    expect(events[1]).toMatchObject({ t: "assistant", text: "hello from probe" });
    // Eighteen types in the recording; nothing the server cannot name travels.
    expect(events.some((e) => e.t === "other")).toBe(false);
  });

  test("a prompt of thousands of lines runs, and does not cross argv", async () => {
    // Bigger than any argv limit worth the name, and the shape of a real stage
    // prompt rather than one long line.
    const prompt = Array.from({ length: 5000 }, (_, i) => `line ${i} of the harness`).join("\n");

    const { completion, probe } = await ran("job-5", prompt);

    expect(completion.outcome).toBe("complete");
    expect(probe.stdin()).toBe(prompt);
    expect(probe.argv().join(" ")).not.toContain("line 4999");
    // `-p` is what would put it on argv, and GitHub documents that piped input
    // is ignored when it is given: both halves of the same mistake.
    expect(probe.argv()).not.toContain("-p");
    expect(probe.argv()).not.toContain("--prompt");
  });

  test("the run is isolated from the operator's Copilot configuration", async () => {
    // The runner is started from the operator's own shell, so this is the
    // environment the engine would inherit if nothing stripped it: their home
    // is where their MCP servers, their instructions and their session state
    // live, and measured, a run under it loads all three.
    const operator = withEnv({
      COPILOT_HOME: "/home/dev/.copilot",
      COPILOT_MODEL: "gpt-4",
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/home/dev/instructions",
    });

    const { probe } = await ran("job-6");
    const env = probe.env();
    operator.restore();

    expect(env.COPILOT_HOME).not.toBe("/home/dev/.copilot");
    expect(env.COPILOT_HOME).toContain("crewbit-copilot-");
    expect(env.COPILOT_MODEL).toBeUndefined();
    expect(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined();
    expect(probe.argv()).toContain("--no-custom-instructions");
  });

  test("and still has the seat, which is the whole premise", async () => {
    // The machine this runs on is one whose seat is Copilot. An isolation that
    // stripped the credential would satisfy the test above and fail every Job,
    // so the two are asserted side by side on purpose.
    const seat = withEnv({ COPILOT_GITHUB_TOKEN: "seat-token", GH_TOKEN: "gh-token" });

    const { probe } = await ran("job-7");
    const env = probe.env();
    seat.restore();

    expect(env.COPILOT_GITHUB_TOKEN).toBe("seat-token");
    expect(env.GH_TOKEN).toBe("gh-token");
    for (const name of ["PATH", "HOME"]) expect(env[name]).toBe(process.env[name] as string);
  });

  test("the home it made is gone once the Job is, and is not shared with the next one", async () => {
    const first = await ran("job-8");
    const second = await ran("job-9");

    const homes = [first.probe.env().COPILOT_HOME, second.probe.env().COPILOT_HOME];
    // One per run rather than one per runner: a shared home would carry the
    // first Job's session state into the second.
    expect(homes[0]).not.toBe(homes[1]);
    // And removed when the run ended, however it ended.
    for (const home of homes) expect(existsSync(home as string)).toBe(false);
  });
});
