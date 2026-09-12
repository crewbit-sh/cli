import { describe, expect, test } from "bun:test";
import { buildArgs, buildEnv } from "./claude-cli.ts";

const base = { prompt: "hi", cwd: "/tmp", maxTurns: 4, onEvent: () => {} };

describe("buildArgs", () => {
  test("always streams, always scopes the settings", () => {
    const args = buildArgs(base);

    expect(args).toContain("--print");
    expect(args.join(" ")).toContain("--output-format stream-json");
    // The developer's global CLAUDE.md and skills are not part of the Job.
    expect(args.join(" ")).toContain("--setting-sources project");
  });

  test("bounds the turns when the harness gave one", () => {
    expect(buildArgs(base).join(" ")).toContain("--max-turns 4");
  });

  test("omits --max-turns when the harness gave none, so the engine runs uncapped", () => {
    const { maxTurns: _maxTurns, ...noCeiling } = base;

    expect(buildArgs(noCeiling).join(" ")).not.toContain("--max-turns");
  });

  test("does not pass the prompt as an argument", () => {
    // Stage prompts are large and argv is not. It goes over stdin instead.
    expect(buildArgs(base)).not.toContain("hi");
  });

  test("omits every optional flag that was not asked for", () => {
    const args = buildArgs(base).join(" ");

    expect(args).not.toContain("--model");
    expect(args).not.toContain("--allowed-tools");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--max-budget-usd");
  });

  // #15: the developer account's claude.ai connectors and MCP servers are
  // fetched from the login, not from a settings file, so no flag scopes them
  // away by naming a source - the config just has to carry none.
  test("always refuses any MCP config, so a Job never sees the developer's connectors", () => {
    const args = buildArgs(base).join(" ");

    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  test("passes through what the harness did ask for", () => {
    const args = buildArgs({
      ...base,
      model: "opus",
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
      maxBudgetUsd: 10,
    }).join(" ");

    expect(args).toContain("--model opus");
    expect(args).toContain("--allowed-tools Read,Edit");
    expect(args).toContain("--permission-mode acceptEdits");
    expect(args).toContain("--max-budget-usd 10");
  });
});

describe("buildEnv", () => {
  test("strips the ambient Claude Code session, so a nested run is not inherited", () => {
    const env = buildEnv({
      PATH: "/usr/bin",
      CLAUDE_CODE_SSE_PORT: "1234",
      CLAUDECODE: "1",
      NODE_OPTIONS: "--inspect",
      VSCODE_INJECTION: "1",
    });

    expect(env).toEqual({ PATH: "/usr/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  });

  test("drops undefined values rather than passing them as the string 'undefined'", () => {
    expect(buildEnv({ PATH: "/usr/bin", EMPTY: undefined })).toEqual({
      PATH: "/usr/bin",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
  });

  // #15: the flag alone leaves connectors unaddressed - the docs name each for
  // a different source - so this has to hold regardless of what the runner's
  // own process was started with.
  test("forces ENABLE_CLAUDEAI_MCP_SERVERS=false even when the runner's own env sets it true", () => {
    const env = buildEnv({ PATH: "/usr/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "true" });

    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });
});
