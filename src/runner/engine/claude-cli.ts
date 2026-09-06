import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { consumeStream, failedResult } from "./stream.ts";
import type { Engine, EngineResult, EngineRun } from "./types.ts";

/** How much stderr to keep for the failure report. */
const STDERR_TAIL_LINES = 40;

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
    "--max-turns",
    String(run.maxTurns),
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

async function spawnAndParse(binary: string, run: EngineRun): Promise<EngineResult> {
  if (run.signal?.aborted) return failedResult("cancelled before the engine started", "cancelled");

  const child = spawn(binary, buildArgs(run), {
    cwd: run.cwd,
    env: buildEnv(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so cancelling can signal the whole tree. Measured:
    // a plain kill(pid) leaves a grandchild running, and `claude` spawns one per
    // tool call, which would keep the workspace busy after the Job is gone.
    detached: true,
  });

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    // Negative pid means the group. Guard: the child may already be gone, and
    // an ESRCH here would surface as a failure the caller cannot act on.
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  };
  run.signal?.addEventListener("abort", cancel, { once: true });

  // Stage prompts run to thousands of lines; argv has a hard size limit.
  child.stdin.end(run.prompt);

  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      if (stderr.length >= STDERR_TAIL_LINES) stderr.shift();
      stderr.push(line);
    }
  });

  const spawnFailure = new Promise<Error>((resolve) => child.on("error", resolve));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );

  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const parsed = await Promise.race([
    consumeStream(lines, run.onEvent),
    spawnFailure.then((error) => error),
  ]);

  if (parsed instanceof Error) {
    run.signal?.removeEventListener("abort", cancel);
    return failedResult(`could not start ${binary}: ${parsed.message}`, "spawn_failed");
  }

  const { code, signal } = await exit;
  run.signal?.removeEventListener("abort", cancel);

  // A result that arrived before the cancel landed still counts: the work was
  // done, and discarding it would be the one thing worse than stopping late.
  if (parsed) return parsed;

  if (cancelled) return failedResult(`${binary} was cancelled`, "cancelled");

  // The stream ended without a result: the engine died mid-run.
  const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
  const tail = stderr.length ? `\n${stderr.join("\n")}` : "";
  return failedResult(`${binary} ${how} before returning a result${tail}`, "no_result");
}
