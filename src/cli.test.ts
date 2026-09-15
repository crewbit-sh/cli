/**
 * The binary's own surface: which words it takes and what it says to somebody
 * who typed the wrong ones.
 *
 * Spawned rather than imported, because `cli.ts` is a script that reads
 * `process.argv` and exits, and half of what is asserted here is the exit code.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_NAMES } from "./commands/runner.ts";

const CLI = new URL("cli.ts", import.meta.url).pathname;

// #8: a machine that holds this project's own runner credential exports it as
// CREWBIT_TOKEN, and spawn() inherits process.env by default, so every one of
// these tests was really dialling wss://d.crewbit.sh and https://app.crewbit.sh
// with it. Nothing here writes into CONFIG_DIR; it stays empty for the whole
// file, standing in for any config a future version might read from HOME.
// UNREACHABLE is a loopback port nothing listens on, so a connection to it
// fails the same way, fast, whether or not this machine can reach the internet.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "crewbit-cli-test-"));
// `crewbit runner` sweeps `crewbit-job-*` under this at startup (#36). Its own
// TMPDIR, not this machine's: a spawned `runner` reading the real one would
// walk and delete whatever this machine actually has sitting there.
const RUNNER_TMPDIR = mkdtempSync(join(tmpdir(), "crewbit-cli-test-tmp-"));
const UNREACHABLE = "ws://127.0.0.1:1";

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: CONFIG_DIR,
    XDG_CONFIG_HOME: CONFIG_DIR,
    TMPDIR: RUNNER_TMPDIR,
  };
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

  test("`runner` sweeps its own leftover job workspaces at startup (#36)", async () => {
    const stale = mkdtempSync(join(RUNNER_TMPDIR, "crewbit-job-"));
    const aDayAndAnHourAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, aDayAndAnHourAgo, aDayAndAnHourAgo);
    const fresh = mkdtempSync(join(RUNNER_TMPDIR, "crewbit-job-"));

    // The connect failure this always ends in (nothing is listening on
    // UNREACHABLE) is what proves the sweep ran to completion rather than
    // being cut off mid-walk: `startRunner` awaits it before that path
    // rethrows, precisely so this is observable at all once the process exits.
    await run("runner", "--token", "t");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("`runner --engine` with a name nobody offers stops before anything else", async () => {
    const { code, out, err } = await run("runner", "--engine", "wibble");
    const said = `${out}${err}`;

    expect(code).toBe(1);
    expect(said).toContain("wibble");
    expect(said).toContain("claude-cli");
    expect(said).toContain("fake");
    // The credential is asked for after the engine, and the socket after that,
    // so neither message appearing is the proof it stopped at the name.
    expect(said).not.toContain("no token given");
    expect(said).not.toContain("could not");
  });

  test("`runner --engine claude-cli` reaches the same place `runner` reaches", async () => {
    // Naming the default engine changes nothing else: with no token anywhere
    // this is the missing credential, exactly as the bare `runner` case above.
    const { code, out } = await run("runner", "--engine", "claude-cli");

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

  /**
   * The shape every one of these shares: a word or two that routes somewhere,
   * refused before a token is even asked for, naming what stopped it. #S8785:
   * one test body against a table reads as one thing to SonarCloud's clone
   * detector, where fifteen near-identical bodies read as fourteen repeats of
   * the first.
   */
  const ROUTES: Array<{ name: string; args: string[]; contains: string }> = [
    {
      name: "`project` routes, and says what it is missing rather than the usage",
      args: ["project", "list"],
      contains: "no token given",
    },
    {
      name: "`project` with no verb names the two it has",
      args: ["project"],
      contains: "crewbit project list",
    },
    {
      name: "`project view` with no id says so rather than listing everything",
      args: ["project", "view"],
      contains: "no Project id given",
    },
    {
      name: "`run` is a noun with verbs now, and `view` is the one that reads",
      args: ["run", "view"],
      contains: "no Run id given",
    },
    {
      // `crewbit run <id>` shipped in v0.5.0 and is gone. An id is not a verb,
      // so it is refused by name rather than treated as one.
      name: "the old `run <id>` says what to type instead of reading a Run named view",
      args: ["run", "run_abc123"],
      contains: "crewbit run view",
    },
    {
      name: "`run approve` routes, and asks for the id before the credential",
      args: ["run", "approve"],
      contains: "no Run id given",
    },
    {
      name: "a verb `run` does not have names the ones it does",
      args: ["run", "merge", "run_1"],
      contains: "approve",
    },
    {
      name: "`run answer` asks for the id before the credential, like the gates do",
      args: ["run", "answer"],
      contains: "no Run id given",
    },
    {
      name: "`run cancel` routes, and asks for the id first",
      args: ["run", "cancel"],
      contains: "no Run id given",
    },
    {
      name: "`run judge` routes, and asks for the id first",
      args: ["run", "judge"],
      contains: "no Run id given",
    },
    {
      name: "`run now` routes, and asks for the id first",
      args: ["run", "now"],
      contains: "no Run id given",
    },
    {
      name: "`spec list` routes, and asks for the Project before the credential",
      args: ["spec", "list"],
      contains: "no Project given",
    },
    {
      name: "`spec plan` with no reference says the exact form it wants",
      args: ["spec", "plan"],
      contains: "acme/api#12",
    },
    {
      // The verb it is, and not `plan`'s form: the unknown-verb message names
      // that one, so a wrong hint here would read as a right one.
      name: "`spec code` with no reference says the exact form it wants",
      args: ["spec", "code"],
      contains: "crewbit spec code acme/api#12",
    },
    {
      // `run` is the old word, kept working and never named back: the message
      // still says `code`, whichever of the two got it here.
      name: "the old `spec run` still routes, and still says `code`",
      args: ["spec", "run"],
      contains: "crewbit spec code acme/api#12",
    },
    {
      name: "`spec` with no verb names the ones it has",
      args: ["spec"],
      contains: "crewbit spec list",
    },
  ];

  test.each(ROUTES)("$name", async ({ args, contains }) => {
    const { code, out, err } = await run(...args);

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain(contains);
  });

  test("`run answer` with no data at all says which flag to pass", async () => {
    const { code, out, err } = await run("run", "answer", "run_1", "--token", "t");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("--data");
    expect(`${out}${err}`).not.toContain("could not reach the server");
  });

  test("`run answer --data` that is not a JSON object is refused before any request", async () => {
    // The server is a port nothing listens on, so a request made anyway would
    // have said it could not be reached. Saying something else is the proof.
    const { code, out, err } = await run("run", "answer", "run_1", "--token", "t", "--data", "[1]");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("--data wants a JSON object");
    expect(`${out}${err}`).not.toContain("could not reach the server");
  });

  test("`run answer --file` that is not there names the file rather than the flag", async () => {
    const { code, out, err } = await run(
      "run",
      "answer",
      "run_1",
      "--token",
      "t",
      "--file",
      join(CONFIG_DIR, "nope.json"),
    );

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("nope.json");
    expect(`${out}${err}`).not.toContain("could not reach the server");
  });

  test('`run answer --file` that walks out with ".." is refused before it is read', async () => {
    const { code, out, err } = await run(
      "run",
      "answer",
      "run_1",
      "--token",
      "t",
      "--file",
      "../../etc/passwd",
    );

    expect(code).toBe(1);
    // Distinct from the generic "could not read <path>" of a file that is
    // simply missing: that message would also contain "..", so what proves
    // this is the guard and not a lucky ENOENT is the wording itself.
    expect(`${out}${err}`).toContain("must not");
    expect(`${out}${err}`).not.toContain("could not read");
    expect(`${out}${err}`).not.toContain("could not reach the server");
  });

  test("`run cancel` with everything it needs is refused for a --server that is not http or https", async () => {
    const { code, out, err } = await run("run", "cancel", "run_1", "--token", "t");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("--server");
    expect(`${out}${err}`).toMatch(/http/i);
  });

  test("`project list` with everything it needs is refused for a --server that is not http or https", async () => {
    const { code, out, err } = await run("project", "list", "--token", "t");

    expect(code).toBe(1);
    expect(`${out}${err}`).toContain("--server");
    expect(`${out}${err}`).toMatch(/http/i);
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
    expect(out).toContain("crewbit run answer <id>");
    expect(out).toContain("crewbit run cancel <id>");
    expect(out).toContain("crewbit run judge <id>");
    expect(out).toContain("crewbit run now <id>");
    expect(out).toContain("crewbit project list");
    expect(out).toContain("crewbit project view <id>");
    expect(out).toContain("crewbit spec list");
    expect(out).toContain("crewbit spec plan");
    expect(out).toContain("crewbit spec code");
    // `run` is a working alias, kept quiet: naming it here would advertise it.
    expect(out).not.toContain("spec run");
  });

  test("--help names --engine and the engines it takes", async () => {
    const { out } = await run("--help");

    expect(out).toContain("--engine");
    // Built from the list rather than written out: an engine nobody can find
    // in `--help` is one nobody will type.
    for (const name of ENGINE_NAMES) expect(out).toContain(name);
  });

  test("--help names neither `--fake` nor Claude Code as the only thing that runs", async () => {
    const { out } = await run("--help");

    // `--fake` is a working alias, kept quiet the same way `spec run` is:
    // naming it would hand somebody a second spelling to discover.
    expect(out).not.toContain("--fake");
    expect(out).not.toContain("with your own Claude Code");
  });

  test("`run view <id>` refuses --events that is not a non-negative whole number", async () => {
    const { code, out } = await run("run", "view", "run_1", "--token", "t", "--events", "abc");

    expect(code).toBe(1);
    expect(out).toContain("--events wants a whole number");
  });
});
