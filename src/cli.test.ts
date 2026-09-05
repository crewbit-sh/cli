/**
 * The binary's own surface: which words it takes and what it says to somebody
 * who typed the wrong ones.
 *
 * Spawned rather than imported, because `cli.ts` is a script that reads
 * `process.argv` and exits, and half of what is asserted here is the exit code.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("cli.ts", import.meta.url).pathname;

// #8: a machine that holds this project's own runner credential exports it as
// CREWBIT_TOKEN, and spawn() inherits process.env by default, so every one of
// these tests was really dialling wss://d.crewbit.sh and https://app.crewbit.sh
// with it. Nothing here writes into CONFIG_DIR; it stays empty for the whole
// file, standing in for any config a future version might read from HOME.
// UNREACHABLE is a loopback port nothing listens on, so a connection to it
// fails the same way, fast, whether or not this machine can reach the internet.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "crewbit-cli-test-"));
const UNREACHABLE = "ws://127.0.0.1:1";

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: CONFIG_DIR, XDG_CONFIG_HOME: CONFIG_DIR };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CREWBIT_")) delete env[key];
  }
  return env;
}

function run(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args, "--server", UNREACHABLE], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv(),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("what the binary is asked to do", () => {
  test("`runner` is what runs one, and it says what it is missing", async () => {
    const { code, out } = await run("runner");

    // No token anywhere, so it stops before dialling. Reaching this message at
    // all is the proof the word routed to the runner.
    expect(code).toBe(1);
    expect(out).toContain("no token given");
  });

  test("the old form says what to type now instead of doing nothing", async () => {
    // `crewbit --token …` was the whole command until this. Somebody has it in a
    // service file, and the worst answer is a binary that starts, takes no work
    // and looks healthy.
    const { code, out } = await run("--token", "not-a-real-token");

    expect(code).toBe(1);
    expect(out).toContain("crewbit runner");
  });

  test("a word it does not know is named back, rather than ignored", async () => {
    const { code, out } = await run("wibble");

    expect(code).toBe(1);
    expect(out).toContain("wibble");
  });

  test("no words at all is the usage, and a failure, because nothing was asked", async () => {
    const { code, out } = await run();

    expect(code).toBe(1);
    expect(out).toContain("crewbit runner");
  });

  test("--help is the usage on purpose, so it succeeds", async () => {
    const { code, out } = await run("--help");

    expect(code).toBe(0);
    expect(out).toContain("crewbit runner");
  });

  test("`project` routes, and says what it is missing rather than the usage", async () => {
    const { code, out, err } = await run("project", "list");

    // No token anywhere, so it stops before dialling. Reaching this message at
    // all is the proof the word routed.
    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("no token given");
  });

  test("`project` with no verb names the two it has", async () => {
    const { code, out, err } = await run("project");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("crewbit project list");
  });

  test("`project view` with no id says so rather than listing everything", async () => {
    const { code, out, err } = await run("project", "view");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("no Project id given");
  });

  test("`run` is a noun with verbs now, and `view` is the one that reads", async () => {
    const { code, out, err } = await run("run", "view");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("no Run id given");
  });

  test("the old `run <id>` says what to type instead of reading a Run named view", async () => {
    // `crewbit run <id>` shipped in v0.5.0 and is gone. An id is not a verb, so
    // it is refused by name rather than treated as one.
    const { code, out, err } = await run("run", "run_abc123");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("crewbit run view");
  });

  test("`run approve` routes, and asks for the id before the credential", async () => {
    const { code, out, err } = await run("run", "approve");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("no Run id given");
  });

  test("a verb `run` does not have names the ones it does", async () => {
    const { code, out, err } = await run("run", "merge", "run_1");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("approve");
  });

  test("`spec list` routes, and asks for the Project before the credential", async () => {
    const { code, out, err } = await run("spec", "list");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("no Project given");
  });

  test("`spec plan` with no reference says the exact form it wants", async () => {
    const { code, out, err } = await run("spec", "plan");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("acme/api#12");
  });

  test("`spec` with no verb names the ones it has", async () => {
    const { code, out, err } = await run("spec");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("crewbit spec list");
  });

  test("--version answers without being told which command", async () => {
    // Asking a binary what it is has no subcommand, and `boundary.test.ts`
    // reaches for this same path to prove the runner still runs under Node.
    const { code, out } = await run("--version");

    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("`run view` with no id says so, before asking for a credential", async () => {
    const { code, out } = await run("run", "view");

    expect(code).toBe(1);
    expect(out).toContain("no Run id given");
  });

  test("`run <id>` with no credential says which one is missing", async () => {
    const { code, out } = await run("run", "view", "run_1");

    expect(code).toBe(1);
    expect(out).toContain("no token given");
  });

  test("`run view <id>` refuses an output it does not know, before reaching the network", async () => {
    const { code, out } = await run("run", "view", "run_1", "--token", "t", "--output", "yaml");

    expect(code).toBe(1);
    expect(out).toContain("ai_agent or json");
  });

  test("--help lists every command the binary has", async () => {
    const { out } = await run("--help");

    expect(out).toContain("crewbit runner");
    expect(out).toContain("crewbit run view <id>");
    expect(out).toContain("crewbit run approve <id>");
    expect(out).toContain("crewbit run reject <id>");
    expect(out).toContain("crewbit run replan <id>");
    expect(out).toContain("crewbit run list");
    expect(out).toContain("crewbit project list");
    expect(out).toContain("crewbit project view <id>");
    expect(out).toContain("crewbit spec list");
    expect(out).toContain("crewbit spec plan");
  });

  test("`run view <id>` refuses --events that is not a non-negative whole number", async () => {
    const { code, out } = await run("run", "view", "run_1", "--token", "t", "--events", "abc");

    expect(code).toBe(1);
    expect(out).toContain("--events wants a whole number");
  });
});
