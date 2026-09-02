import { describe, expect, test } from "bun:test";
import { buildArgs, buildEnv } from "./claude-cli.ts";

const base = { prompt: "hi", cwd: "/tmp", maxTurns: 4, onEvent: () => {} };

describe("buildArgs", () => {
  test("always streams, always bounds the turns, always scopes the settings", () => {
    const args = buildArgs(base);

    expect(args).toContain("--print");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args.join(" ")).toContain("--max-turns 4");
    // The developer's global CLAUDE.md and skills are not part of the Job.
    expect(args.join(" ")).toContain("--setting-sources project");
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

  test("passes through what the harness did ask for", () => {
    const args = buildArgs({
      ...base,
      model: "opus",
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
      resumeSessionId: "a7ea0a98",
      maxBudgetUsd: 10,
    }).join(" ");

    expect(args).toContain("--model opus");
    expect(args).toContain("--allowed-tools Read,Edit");
    expect(args).toContain("--permission-mode acceptEdits");
    expect(args).toContain("--resume a7ea0a98");
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

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("drops undefined values rather than passing them as the string 'undefined'", () => {
    expect(buildEnv({ PATH: "/usr/bin", EMPTY: undefined })).toEqual({ PATH: "/usr/bin" });
  });
});
