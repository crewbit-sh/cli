import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aiCredits,
  buildCopilotArgs,
  buildCopilotEnv,
  copilotCliEngine,
  semverFrom,
} from "./copilot-cli.ts";

const base = { prompt: "hi", cwd: "/tmp", onEvent: () => {} };

describe("buildCopilotArgs", () => {
  test("always streams JSONL and always allows its tools", () => {
    const args = buildCopilotArgs(base).join(" ");

    // `--allow-all-tools` is documented as required for non-interactive mode:
    // without it the run stops on the first tool asking for permission.
    expect(args).toContain("--output-format json");
    expect(args).toContain("--allow-all-tools");
  });

  test("never lets the agent ask a question nobody is there to answer", () => {
    expect(buildCopilotArgs(base)).toContain("--no-ask-user");
  });

  // The Job carries its own harness. The operator's AGENTS.md and the
  // instructions under their COPILOT_HOME are not part of it.
  test("refuses the operator's custom instructions", () => {
    expect(buildCopilotArgs(base)).toContain("--no-custom-instructions");
  });

  test("does not pass the prompt as an argument", () => {
    // Stage prompts run to thousands of lines and argv does not. `-p` is what
    // would put it there, so its absence is the assertion: piped input is
    // ignored when `-p` is given.
    expect(buildCopilotArgs(base)).not.toContain("hi");
    expect(buildCopilotArgs(base)).not.toContain("-p");
    expect(buildCopilotArgs(base)).not.toContain("--prompt");
  });

  test("omits every optional flag that was not asked for", () => {
    const args = buildCopilotArgs(base).join(" ");

    expect(args).not.toContain("--model");
    expect(args).not.toContain("--max-ai-credits");
    expect(args).not.toContain("--resume");
  });

  // #42 removed the turn ceiling from this runner. Copilot has no `--max-turns`
  // to pass either, and nothing here is to grow one.
  test("never bounds the turns, whatever else the run asks for", () => {
    const args = buildCopilotArgs({ ...base, model: "gpt-5", maxBudgetUsd: 5 }).join(" ");

    expect(args).not.toContain("--max-turns");
  });

  test("passes through the model the harness asked for", () => {
    expect(buildCopilotArgs({ ...base, model: "gpt-5" }).join(" ")).toContain("--model gpt-5");
  });

  // `allowedTools` and `permissionMode` are Claude's vocabulary. A harness
  // naming `Read` and `Edit` names tools Copilot does not have - measured, they
  // are `view`, `bash`, `edit` - so mapping them to `--available-tools` would
  // narrow the run to nothing at all.
  test("ignores the tool names and permission mode, which belong to another engine", () => {
    const args = buildCopilotArgs({
      ...base,
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
    }).join(" ");

    expect(args).not.toContain("Read");
    expect(args).not.toContain("--available-tools");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("--allow-all-tools");
  });

  test("a budget the flag can express becomes credits", () => {
    expect(buildCopilotArgs({ ...base, maxBudgetUsd: 1 }).join(" ")).toContain(
      "--max-ai-credits 100",
    );
  });

  // Measured: `--max-ai-credits 5` is refused by the CLI's own argument
  // validation, before any JSONL, with "Use at least 30 AI credits". Passing a
  // budget under the floor would fail the Job for asking to be careful with it.
  test("a budget under the flag's floor runs unbounded rather than failing", () => {
    const args = buildCopilotArgs({ ...base, maxBudgetUsd: 0.29 }).join(" ");

    expect(args).not.toContain("--max-ai-credits");
    expect(args).toContain("--allow-all-tools");
  });
});

describe("aiCredits", () => {
  test("a dollar is a hundred credits", () => {
    expect(aiCredits(1)).toBe(100);
  });

  test("the floor the flag documents is the smallest it will express", () => {
    expect(aiCredits(0.3)).toBe(30);
    expect(aiCredits(0.29)).toBeUndefined();
  });

  test("floats do not lose a credit to binary arithmetic", () => {
    // 1.15 * 100 is 114.99999999999999 in doubles, and flooring that asks for
    // less than the Job was given.
    expect(aiCredits(1.15)).toBe(115);
  });

  test("rounds down, so the flag never asks for more than the budget allowed", () => {
    expect(aiCredits(1.009)).toBe(100);
  });

  test("no budget is no ceiling", () => {
    expect(aiCredits(undefined)).toBeUndefined();
    expect(aiCredits(0)).toBeUndefined();
  });
});

describe("buildCopilotEnv", () => {
  const home = "/tmp/copilot-home-1";

  test("points the run at the home it was given, whatever the operator's own is", () => {
    const env = buildCopilotEnv({ PATH: "/usr/bin", COPILOT_HOME: "/home/dev/.copilot" }, home);

    expect(env.COPILOT_HOME).toBe(home);
  });

  // Measured: under the operator's own home `copilot mcp list` reports their
  // servers and their instructions load; under a home that did not exist, one
  // built-in server loads and nothing of theirs does. The home is the whole
  // isolation, and the environment is the door it would otherwise arrive by.
  test("strips the operator's Copilot configuration arriving by environment", () => {
    const env = buildCopilotEnv(
      {
        PATH: "/usr/bin",
        COPILOT_MODEL: "gpt-4",
        COPILOT_ALLOW_ALL: "1",
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/home/dev/instructions",
      },
      home,
    );

    expect(env.COPILOT_MODEL).toBeUndefined();
    expect(env.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined();
  });

  // The premise is a machine whose seat is Copilot. An isolation that costs the
  // seat has failed rather than succeeded, so the credential survives the sweep.
  test("keeps the seat: the token and the host it authenticates against", () => {
    const env = buildCopilotEnv(
      {
        PATH: "/usr/bin",
        COPILOT_GITHUB_TOKEN: "t",
        COPILOT_GH_HOST: "github.example.com",
        GH_TOKEN: "g",
        GITHUB_TOKEN: "h",
      },
      home,
    );

    expect(env.COPILOT_GITHUB_TOKEN).toBe("t");
    expect(env.COPILOT_GH_HOST).toBe("github.example.com");
    // Measured: these are what `copilot` falls back to, and neither matches the
    // prefix the sweep above is written against.
    expect(env.GH_TOKEN).toBe("g");
    expect(env.GITHUB_TOKEN).toBe("h");
  });

  // A runner is often started from inside a Claude Code session, and `copilot`
  // is a node process that would inherit its NODE_OPTIONS.
  test("strips the ambient Claude Code session, the way the first engine does", () => {
    const env = buildCopilotEnv(
      {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SSE_PORT: "1234",
        NODE_OPTIONS: "--inspect",
        VSCODE_INJECTION: "1",
      },
      home,
    );

    expect(env).toEqual({ PATH: "/usr/bin", COPILOT_HOME: home });
  });

  test("drops undefined values rather than passing them as the string 'undefined'", () => {
    expect(buildCopilotEnv({ PATH: "/usr/bin", EMPTY: undefined }, home)).toEqual({
      PATH: "/usr/bin",
      COPILOT_HOME: home,
    });
  });
});

describe("semverFrom", () => {
  // Measured: `copilot --version` prints a sentence, not a version, and does it
  // in 0.3s with no network and a COPILOT_HOME that does not exist.
  test("reads the version out of the sentence the binary prints", () => {
    expect(
      semverFrom("GitHub Copilot CLI 1.0.83.\nRun 'copilot update' to check for updates.\n"),
    ).toBe("1.0.83");
  });

  test("output with no version in it is unknown rather than a guess", () => {
    expect(semverFrom("command not found")).toBe("unknown");
    expect(semverFrom("")).toBe("unknown");
  });
});

/**
 * The handshake claim, through the seam an operator actually reaches: an
 * `Engine` built from a name, asked for its version. A stand-in stands in for
 * the binary because the assertion is about what this module does with what
 * `copilot --version` prints, and a machine without Copilot installed should
 * still be able to run the suite.
 */
describe("the version the handshake reports", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** Prints what `copilot --version` prints, and records that it was run. */
  function versionStandIn(): { binary: string; ran: () => boolean } {
    const dir = mkdtempSync(join(tmpdir(), "crewbit-copilot-version-"));
    dirs.push(dir);
    const binary = join(dir, "copilot.sh");
    const marker = join(dir, "ran");
    writeFileSync(
      binary,
      `#!/bin/sh
touch '${marker}'
echo 'GitHub Copilot CLI 1.0.83.'
echo "Run 'copilot update' to check for updates."
`,
    );
    chmodSync(binary, 0o755);
    return { binary, ran: () => existsSync(marker) };
  }

  test('is what the installed binary says, not "unknown"', () => {
    const { binary } = versionStandIn();

    expect(copilotCliEngine({ binary }).version).toBe("1.0.83");
  });

  // `engineNamed` builds an engine before a socket exists and long before a
  // Job does, and `src/commands/runner.test.ts` holds that building one spawns
  // nothing. Reading the version eagerly would break that from here.
  test("building the engine runs nothing; asking for the version is what runs it", () => {
    const { binary, ran } = versionStandIn();

    const engine = copilotCliEngine({ binary });
    expect(ran()).toBe(false);

    expect(engine.version).toBe("1.0.83");
    expect(ran()).toBe(true);
  });

  test("names the engine an operator asked for by name", () => {
    expect(copilotCliEngine().kind).toBe("copilot-cli");
  });
});
