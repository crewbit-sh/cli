/**
 * Preparing the directory a Stage works in.
 *
 * A Stage that is told to explore a codebase needs the codebase. Without a
 * checkout the plan stage receives an empty directory, and "every path you name
 * must exist" becomes something it cannot honour.
 *
 * Shallow, because a plan needs the tree and not the history.
 */

import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type { JobAssignParams } from "@crewbit/protocol";
import type { Logger } from "../log.ts";
import { BASE_REF, diffSince, git, mergeBase, withToken } from "./git.ts";

export type WorkspaceInput = {
  context: Record<string, string>;
  /** Whether this Stage puts something on the remote. Only the code stage does. */
  delivers?: boolean;
  /**
   * Whether this Stage works on top of the branch the Run already has.
   *
   * Separate from `delivers`, and the separation is the whole point. There are
   * three kinds of Stage, not two: the plan stage reads the base, the code stage
   * reads the branch and pushes, and the eval stage reads the branch and pushes
   * nothing. Deriving this from `delivers` gave the eval a fresh branch at the
   * base's tip, so every verdict ever produced judged the base against itself
   * and reported "no change submitted" about work sitting on the remote.
   *
   * A Stage that only reads the base must not take the branch either, for the
   * opposite reason: it would be pinned to whatever the tree looked like when
   * the first Job for this Spec ran, which is how two re-planned Specs produced
   * refusals describing a repository from two hours before.
   */
  continues?: boolean;
  repo?: JobAssignParams["repo"];
  /**
   * The files the Job will collect afterwards, which the Stage writes and the
   * server reads back. Excluded from the commit for the same reason the context
   * is: they describe the change rather than being part of it.
   */
  artifacts?: string[];
  /** Where a checkout carrying something removed by `sanitizeClaudeConfig` is reported. */
  log?: Logger;
  jobId?: string;
};

export async function prepareWorkspace(input: WorkspaceInput): Promise<string> {
  const workspace = await mkdtemp(`${tmpdir()}${sep}crewbit-job-`);

  try {
    if (input.repo) {
      await clone(input.repo, workspace, input.continues ?? input.delivers ?? true);
      await sanitizeClaudeConfig(workspace, input.log, input.jobId);
    }
    // Context second, so a repository file is never replaced by one: a Stage
    // reading a source file must see the real one.
    await writeContext(workspace, input.context, Boolean(input.repo));

    if (input.repo) {
      // What this branch already changed, for a Stage that reviews rather than
      // writes. Absent rather than empty when there is nothing: an empty file
      // reads as "the change is empty" instead of "there is no change".
      const diff = await diffSince(workspace);
      const written = Object.keys(input.context);
      if (diff) {
        await writeFile(resolve(workspace, DIFF_FILE), diff, "utf8");
        written.push(DIFF_FILE);
      }
      await ignoreLocally(workspace, [...written, ...(input.artifacts ?? [])]);
    }
    return workspace;
  } catch (cause) {
    await rm(workspace, { recursive: true, force: true });
    throw cause;
  }
}

async function clone(
  repo: NonNullable<WorkspaceInput["repo"]>,
  into: string,
  continues: boolean,
): Promise<void> {
  const url = withToken(repo.url, repo.token);
  const cloned = await git(["clone", "--depth", "1", "--branch", repo.baseBranch, url, "."], into);

  if (cloned.code !== 0) {
    // Never the url: it carries the credential. What git said is safe, because
    // `git()` takes the credential out of it before anyone sees it, and without
    // it an exit code is not something anybody can act on.
    throw new Error(
      `could not clone ${repo.url} at ${repo.baseBranch} (git exited ${cloned.code})` +
        (cloned.stderr ? `\n${cloned.stderr}` : ""),
    );
  }

  // Where the work started, stamped from the base before anything moves HEAD.
  // `origin/<base>` would say the same and does not survive removing the remote.
  await git(["update-ref", BASE_REF, "HEAD"], into);

  // Continue the branch when the remote already has it. A second runner handed
  // the same Job, and a fix round, both land here: without this they clone the
  // base, create the branch again, and their push is a non-fast-forward the
  // guard then fails, which is a retry that can never succeed.
  //
  // Shallow, because the diff compares two trees and does not need the history
  // between them.
  // Only a Stage that continues the work reaches for the branch. Both
  // directions of getting this wrong have happened: the plan stage taking the
  // branch pinned re-planned Specs to an old snapshot, and the eval stage not
  // taking it judged the base against itself.
  const existing = continues
    ? (await git(["fetch", "--depth", "1", url, repo.branch], into)).code
    : 1;
  const branched =
    existing === 0
      ? await git(["checkout", "-q", "-B", repo.branch, "FETCH_HEAD"], into)
      : // The first round of a Run, where there is nothing to continue. The
        // branch the server named, always, even for a read-only Stage: a Stage
        // that commits when it should not have does so somewhere harmless.
        await git(["checkout", "-q", "-b", repo.branch], into);
  if (branched.code !== 0) {
    throw new Error(
      `could not check out ${repo.branch} (git exited ${branched.code})` +
        (branched.stderr ? `\n${branched.stderr}` : ""),
    );
  }

  // The branch existed, so it was cut from a base that has since moved, and the
  // ref stamped above is the base's tip rather than where this work started.
  if (existing === 0) await stampForkPoint(url, repo, into);

  // Local to this clone, never global. Without it a commit is attributed to
  // whoever owns the machine, and on a shared runner that is the wrong person.
  await git(["config", "--local", "user.name", COMMITTER.name], into);
  await git(["config", "--local", "user.email", COMMITTER.email], into);

  // The remote is removed, and this is the security boundary rather than a
  // convenience. `git clone` records the url it was handed, token and all, so an
  // agent with Bash reads the credential out of `.git/config`. Removing the
  // remote takes the token off the disk and leaves the agent with nowhere to
  // push, which git enforces.
  //
  // Measured on claude 2.1.222: `--disallowed-tools "Bash(git push:*)"` does not
  // deny a Bash subcommand while Bash is allowed, with or without the colon. A
  // deny list there would have been decoration.
  //
  // The runner keeps pushing because it names the destination on the command
  // line rather than through a configured remote.
  await git(["remote", "remove", "origin"], into);
}

/**
 * What a checked-out repository may hand the engine, and what it may not.
 *
 * `.claude/rules/**` and `.claude/CLAUDE.md` are project instructions: markdown
 * a Stage reads as context, the same category the server's own rules Spec
 * writes into a target repository. Everything else `.claude/` can hold is a way
 * to make the engine act the moment it starts, not just inform it: `settings.json`
 * and `settings.local.json` carry `hooks`, which run a shell command on their
 * own schedule (`PreToolUse`, `SessionStart`, ...) with no `--permission-mode` or
 * `--allowed-tools` gate over them; `agents/`, `commands/` and `skills/` are
 * each a way to extend what the engine can be made to invoke. A root
 * `.mcp.json` is the same problem one level up: a project MCP server is a
 * command the engine starts on its own.
 *
 * `--setting-sources project` on the CLI invocation cannot be narrowed to load
 * the rules without loading the rest of `.claude/` too — both come from the
 * same source — so the checkout is sanitised on disk instead, right after the
 * clone and before anything reads it.
 */
const CLAUDE_KEEP = new Set(["rules", "CLAUDE.md"]);

async function sanitizeClaudeConfig(
  workspace: string,
  log?: Logger,
  jobId?: string,
): Promise<void> {
  const removed: string[] = [];

  const claudeDir = resolve(workspace, ".claude");
  const entries = await readdir(claudeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (CLAUDE_KEEP.has(entry.name)) continue;
    await rm(resolve(claudeDir, entry.name), { recursive: true, force: true });
    removed.push(`.claude/${entry.name}`);
  }

  const mcpConfig = resolve(workspace, ".mcp.json");
  if (await exists(mcpConfig)) {
    await rm(mcpConfig, { force: true });
    removed.push(".mcp.json");
  }

  // Only when there was something to say: the ordinary Job clones a repository
  // with none of this, and a line on every one of them would bury the Job that
  // actually carried something.
  if (removed.length > 0) {
    log?.warning("removed engine configuration the checkout carried", {
      job_id: jobId,
      removed,
    });
  }
}

/**
 * How much of the base's history to pull back to find where the branch left it.
 *
 * The clone is `--depth 1` and a shallow clone has no common ancestor to
 * compute: `.git/shallow` holds both tips and `merge-base` answers with nothing.
 * Two hundred commits of the base covers a Run that stayed open for weeks, and
 * a branch older than that is too stale to continue, which is worth being told
 * rather than papering over. The cost is history for those commits on every fix
 * round, which is the price of a diff that is true.
 */
const BASE_DEPTH = 200;

/**
 * Moves the base ref to where the branch actually diverged.
 *
 * Without it, `git diff base..HEAD` compares two trees whose common history the
 * clone does not have, so everything the base gained since reads as a deletion.
 * One Run's diff was nineteen files of other people's work shown as removed,
 * including a whole test file, and the eval's fraud scan failed the change for
 * deleting tests it had never touched.
 *
 * Moving the ref rather than changing the diff means `commitsSince` is corrected
 * by the same act, so the pull request body and the diff cannot disagree.
 */
async function stampForkPoint(
  url: string,
  repo: NonNullable<WorkspaceInput["repo"]>,
  into: string,
): Promise<void> {
  await git(["fetch", "--deepen", String(BASE_DEPTH), url, repo.baseBranch, repo.branch], into);

  const fork = await mergeBase(BASE_REF, "HEAD", into);
  if (!fork) {
    // Never a wrong diff. A reviewer shown the base's work as deletions fails a
    // change that is correct, and that is more expensive than a Job that stops.
    throw new Error(
      `could not find where ${repo.branch} left ${repo.baseBranch}: ` +
        `no common commit within ${BASE_DEPTH} of the base`,
    );
  }
  await git(["update-ref", BASE_REF, fork], into);
}

/**
 * Keeps the Job's own paperwork out of the repository it is working on.
 *
 * The workspace root is the clone, so `git add -A` sees `spec.md` and `plan.md`
 * sitting beside the source and commits them, and the pull request then carries
 * the factory's paperwork as a change. `.git/info/exclude` is git's per-clone
 * ignore list: it is not committed, so this never edits the project's own
 * `.gitignore`.
 *
 * An ignore rule rather than filtering the commit ourselves, for two properties
 * that come free with it. The files stay on disk, so the Stage still reads and
 * rewrites them by relative path while it works. And a file the repository
 * already tracks is unaffected by any ignore rule, so a Job that legitimately
 * edits a file whose name collides with an artifact still commits that edit.
 */
async function ignoreLocally(workspace: string, names: string[]): Promise<void> {
  // Anchored to the workspace root, which is what the leading slash means to
  // git. A bare `plan.md` matches at every depth, so a repository growing a
  // genuinely new `docs/plan.md` would have it dropped from the commit without
  // saying so, and a silent drop is worse than the paperwork it was avoiding.
  const patterns = [
    ...new Set(names.filter(Boolean).map((name) => `/${name.replace(/^\/+/, "")}`)),
  ];
  if (patterns.length === 0) return;
  const path = resolve(workspace, ".git", "info", "exclude");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `\n# crewbit: this Job's own files\n${patterns.join("\n")}\n`, "utf8");
}

/** What the eval stage reads instead of running git itself. */
export const DIFF_FILE = "diff.md";

/** Who the factory commits as. Recognisable in a blame, and not a person. */
const COMMITTER = { name: "crewbit", email: "crewbit@users.noreply.github.com" };

async function writeContext(
  workspace: string,
  context: Record<string, string>,
  skipExisting: boolean,
): Promise<void> {
  for (const [name, content] of Object.entries(context)) {
    const target = resolve(workspace, name);
    // The server is trusted, but a filename is still input. One bad entry must
    // not be able to write outside the Job's own directory.
    if (target !== workspace && !target.startsWith(workspace + sep)) {
      throw new Error(`context file escapes the workspace: ${name}`);
    }
    if (skipExisting && (await exists(target))) continue;

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

// node:fs only: the runner package runs under Node as well, and reaching for a
// Bun global here is exactly what the portability check exists to catch.
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
