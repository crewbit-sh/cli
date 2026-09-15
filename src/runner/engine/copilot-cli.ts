/**
 * GitHub Copilot CLI as an engine: its argv, its environment, its isolation,
 * and the words for each way a run can end. The process itself is `spawn.ts`'s,
 * and the stream is `copilot-stream.ts`'s, which is what this file being short
 * is evidence of rather than a claim about.
 *
 * Everything below was measured against Copilot CLI 1.0.83 on 2026-09-15, and
 * `fixtures/copilot-ok.jsonl` is one of those runs kept.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeCopilotStream } from "./copilot-stream.ts";
import { spawnLines } from "./spawn.ts";
import { failedResult } from "./stream.ts";
import type { Engine, EngineResult, EngineRun } from "./types.ts";

export type CopilotCliOptions = { binary?: string; version?: string };

/**
 * `version` is read from the binary rather than declared, and read lazily: the
 * handshake is the first thing that wants it, and `engineNamed` builds an engine
 * long before a Job exists. Building one still spawns nothing.
 */
export function copilotCliEngine(options: CopilotCliOptions = {}): Engine {
  const binary = options.binary ?? "copilot";
  let version = options.version;

  return {
    kind: "copilot-cli",
    get version(): string {
      // Once: the answer cannot change under a running process, and the
      // handshake is sent again on every reconnect.
      version ??= installedVersion(binary);
      return version;
    },
    run: (run) => spawnAndParse(binary, run),
  };
}

/**
 * Measured: `copilot --version` prints `GitHub Copilot CLI 1.0.83.` and a line
 * about updates, to stdout, in 0.3s, with no network and with a `COPILOT_HOME`
 * that does not exist. The semantic version out of it is what `engine.version`
 * means everywhere else on the handshake; the sentence around it is not.
 */
export function semverFrom(output: string): string {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "unknown";
}

/**
 * `"unknown"` when the binary cannot be run at all. That is the case a missing
 * `copilot` reaches, and a runner that crashed on its handshake instead would
 * be a worse answer than one that started and failed its first Job by name.
 */
function installedVersion(binary: string): string {
  try {
    return semverFrom(
      execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: VERSION_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return "unknown";
  }
}

const VERSION_TIMEOUT_MS = 10_000;

/**
 * GitHub bills Copilot in AI credits at $0.01 each, so a dollar is a hundred.
 *
 * Measured: `--max-ai-credits 5` is refused by the CLI's own argument
 * validation with "Use at least 30 AI credits", before any JSONL and before any
 * work. So a budget under the floor is not merely unexpressible, it is fatal if
 * passed, and the flag is omitted entirely rather than clamped up to 30 - a Job
 * given 29 cents does not get 30 cents' worth of room because of a flag.
 *
 * Rounds down, so the flag never asks for more than the Job was given. The
 * multiplication is fixed to six places first because `1.15 * 100` is
 * 114.99999999999999 in doubles, and flooring that would lose a credit.
 */
export function aiCredits(maxBudgetUsd: number | undefined): number | undefined {
  if (!maxBudgetUsd || maxBudgetUsd <= 0) return undefined;
  const credits = Math.floor(Number((maxBudgetUsd * CREDITS_PER_USD).toFixed(6)));
  return credits >= MIN_AI_CREDITS ? credits : undefined;
}

const CREDITS_PER_USD = 100;
/** The CLI's own floor, measured against its argument validation. */
const MIN_AI_CREDITS = 30;

/**
 * The prompt is not here, and that is deliberate: it goes over stdin. `-p` is
 * what would put it on argv, which has a hard size limit a stage prompt of
 * thousands of lines reaches, and GitHub documents that piped input is ignored
 * when `-p` is given - so passing both would silently run the wrong prompt.
 *
 * `allowedTools` and `permissionMode` are read from nothing here. They are
 * Claude's vocabulary: a harness naming `Read` and `Edit` names tools this
 * engine does not have - measured, they are `view`, `bash`, `edit` and so on -
 * so mapping them onto `--available-tools` would narrow a run to nothing.
 */
export function buildCopilotArgs(run: EngineRun): string[] {
  const args = [
    "--output-format",
    "json",
    // Documented as required for non-interactive mode: without it the run stops
    // at the first tool asking a permission nobody is there to grant.
    "--allow-all-tools",
    // The other half of nobody being there: `ask_user` would block forever.
    "--no-ask-user",
    // The Job carries its own harness. The operator's AGENTS.md and the
    // instructions under their own home are not part of it.
    "--no-custom-instructions",
  ];
  if (run.model) args.push("--model", run.model);
  const credits = aiCredits(run.maxBudgetUsd);
  if (credits !== undefined) args.push("--max-ai-credits", String(credits));
  return args;
}

/**
 * `COPILOT_HOME` is the whole isolation, and it costs nothing: measured,
 * pointed at a directory that did not exist, a run still authenticated and
 * completed - so the credential does not live under it - while `copilot mcp
 * list` under that home reported none of the operator's servers where their own
 * home reports `mastra` and `trello`. No credential is copied, linked or read
 * to get that.
 *
 * The environment is the other door. `COPILOT_*` is the operator's
 * configuration arriving by it - `COPILOT_MODEL`, `COPILOT_ALLOW_ALL`,
 * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` - and is stripped, except the two that are
 * the seat itself. `GH_TOKEN` and `GITHUB_TOKEN` do not match the prefix and
 * survive untouched: stripping any of the four would be an isolation that costs
 * the seat, which the whole premise here rules out.
 *
 * The ambient Claude Code session goes the way `claude-cli.ts` sends it, for
 * the same measured reason: a runner is often started from inside one, and
 * `copilot` is a node process that would inherit its `NODE_OPTIONS`.
 */
export function buildCopilotEnv(source: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const blocked = new Set([
    "CLAUDECODE",
    "NODE_OPTIONS",
    "VSCODE_INSPECTOR_OPTIONS",
    "VSCODE_INJECTION",
  ]);
  const seat = new Set(["COPILOT_GITHUB_TOKEN", "COPILOT_GH_HOST"]);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (blocked.has(key) || key.startsWith("CLAUDE_CODE_")) continue;
    if (key.startsWith("COPILOT_") && !seat.has(key)) continue;
    env[key] = value;
  }
  // Forced last, so a `COPILOT_HOME` the runner's own process was started with
  // cannot point a Job back at the operator's configuration.
  env.COPILOT_HOME = home;
  return env;
}

/**
 * A fresh home per run rather than one per runner: a shared one would carry the
 * first Job's session state into the second, and `mkdtemp` costs nothing.
 * Removed when the run ends, however it ended.
 */
async function spawnAndParse(binary: string, run: EngineRun): Promise<EngineResult> {
  const home = mkdtempSync(join(tmpdir(), "crewbit-copilot-"));
  let outcome: Awaited<ReturnType<typeof spawnLines<EngineResult | null>>>;
  try {
    outcome = await spawnLines(
      {
        binary,
        args: buildCopilotArgs(run),
        cwd: run.cwd,
        env: buildCopilotEnv(process.env, home),
        // Stage prompts run to thousands of lines; argv has a hard size limit.
        stdin: run.prompt,
        signal: run.signal,
      },
      (lines) => consumeCopilotStream(lines, run.onEvent),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

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

  // Measured: a run that could not authenticate produced zero JSONL lines and
  // exited 1, so this is not a hypothetical arm. The stderr tail is where the
  // CLI put the reason.
  const how = outcome.signal ? `killed by ${outcome.signal}` : `exited with code ${outcome.code}`;
  const tail = outcome.stderr.length ? `\n${outcome.stderr.join("\n")}` : "";
  return failedResult(`${binary} ${how} before returning a result${tail}`, "no_result");
}
