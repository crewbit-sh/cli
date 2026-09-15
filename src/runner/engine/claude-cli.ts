import { spawnLines } from "./spawn.ts";
import { consumeStream, failedResult } from "./stream.ts";
import type { Engine, EngineResult, EngineRun } from "./types.ts";

export type ClaudeCliOptions = { binary?: string; version?: string };

export function claudeCliEngine(options: ClaudeCliOptions = {}): Engine {
  const binary = options.binary ?? "claude";

  return {
    kind: "claude-cli",
    version: options.version ?? "unknown",
    run: (run) => spawnAndParse(binary, run),
  };
}

/**
 * #14: never `--resume`. The workspace is always new (`mkdtemp`), so a resumed
 * conversation pointed at paths already deleted, and it carried every turn of
 * every earlier attempt with it - one session read 61 workspaces in a night.
 * A Job always starts a clean session now.
 */
export function buildArgs(run: EngineRun): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    // The Job carries its own harness. The developer's global CLAUDE.md and
    // skills are not part of it, and loading them costs cache-creation tokens.
    "--setting-sources",
    "project",
    // #15: no `--mcp-config` to name, so the developer account's claude.ai
    // connectors and the user-scoped servers of `~/.claude.json` are refused
    // rather than merely unnamed. `--setting-sources project` does not cover
    // them - connectors are fetched from the subscription login, not a file.
    "--strict-mcp-config",
  ];
  if (run.model) args.push("--model", run.model);
  if (run.allowedTools?.length) args.push("--allowed-tools", run.allowedTools.join(","));
  if (run.permissionMode) args.push("--permission-mode", run.permissionMode);
  // The run's only ceiling. There is no `--max-turns` here and there is not
  // meant to be one: crewbit-v2#303 replaced the turn ceiling with this budget,
  // and crewbit-v2's own measurements found 5 of 12 code Jobs past the ceiling
  // they were given, so it was never a hard stop to begin with.
  if (run.maxBudgetUsd) args.push("--max-budget-usd", String(run.maxBudgetUsd));
  return args;
}

/**
 * A runner is often started from inside a Claude Code session. Inheriting that
 * session's variables makes the child attach to the parent instead of starting
 * clean, so they are stripped.
 */
export function buildEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = new Set([
    "CLAUDECODE",
    "NODE_OPTIONS",
    "VSCODE_INSPECTOR_OPTIONS",
    "VSCODE_INJECTION",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (blocked.has(key) || key.startsWith("CLAUDE_CODE_")) continue;
    env[key] = value;
  }
  // #15: forced last, so nothing the runner's own process was started with
  // can turn the developer account's connectors back on. `--strict-mcp-config`
  // is silent on connectors specifically - the docs name each for a different
  // source - so both apply rather than one standing in for the other.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

/**
 * What is left of this once `spawn.ts` owns the process: the engine's argv, its
 * environment, the parser, and the words for each way a run can end. The
 * `terminalReason`s below are the vocabulary the runner reads - `reason.ts`
 * decides what is worth retrying from them - so they stay here rather than in a
 * module that knows nothing about Jobs.
 */
async function spawnAndParse(binary: string, run: EngineRun): Promise<EngineResult> {
  const outcome = await spawnLines(
    {
      binary,
      args: buildArgs(run),
      cwd: run.cwd,
      env: buildEnv(process.env),
      // Stage prompts run to thousands of lines; argv has a hard size limit.
      stdin: run.prompt,
      signal: run.signal,
    },
    (lines) => consumeStream(lines, run.onEvent),
  );

  if (outcome.kind === "cancelled_before_start") {
    return failedResult("cancelled before the engine started", "cancelled");
  }
  if (outcome.kind === "spawn_failed") {
    return failedResult(`could not start ${binary}: ${outcome.error.message}`, "spawn_failed");
  }

  // A result that arrived before the cancel landed still counts: the work was
  // done, and discarding it would be the one thing worse than stopping late.
  if (outcome.value) return outcome.value;

  if (outcome.cancelled) return failedResult(`${binary} was cancelled`, "cancelled");

  // The stream ended without a result: the engine died mid-run.
  const how = outcome.signal ? `killed by ${outcome.signal}` : `exited with code ${outcome.code}`;
  const tail = outcome.stderr.length ? `\n${outcome.stderr.join("\n")}` : "";
  return failedResult(`${binary} ${how} before returning a result${tail}`, "no_result");
}
