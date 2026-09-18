/**
 * The git operations a writing Stage needs, and the guard around the push.
 *
 * The guard is the load-bearing part: if commits exist locally and the push
 * fails, a PR marked ready is missing exactly those commits, and the fix loop
 * then repeats forever on a criterion the code actually satisfies. So a push
 * is verified against the remote rather than believed because it exited zero.
 *
 * `node:child_process` only, no Bun API: this package runs under Node too.
 */

import { spawn } from "node:child_process";
import type { JobAssignParams } from "@crewbit/protocol";

type Repo = NonNullable<JobAssignParams["repo"]>;

/** The commit a Job started from, so its own commits can be told apart. */
export const BASE_REF = "refs/crewbit/base";

/**
 * What this Job knows the remote to hold on its branch, and the lease its push
 * carries. Absent means a first round, which holds no lease and forces nothing.
 *
 * Stamped by the clone from the tip it fetched, and moved by every push this Job
 * lands. Never read from the remote at push time: a lease taken just before the
 * push would agree with whatever is there, which is a blind force wearing a
 * lease's name.
 */
export const LEASE_REF = "refs/crewbit/remote";

/**
 * Pushes the current branch. Reports rather than throws: the caller decides.
 *
 * `stderr` rather than only the verdict, because the caller cannot ask again.
 * A push that fails is reported to a person who has no access to this machine,
 * and "it did not push" is the same sentence for a remote that is gone, a ref
 * that already exists, and a credential that expired.
 */
export async function pushed(
  workspace: string,
  repo: Repo,
): Promise<{ ok: boolean; stderr: string }> {
  const lease = await capture(["rev-parse", "--verify", "--quiet", LEASE_REF], workspace);
  // Read before the push, so what the lease advances to is what was actually
  // sent rather than whatever HEAD became while the push was in flight.
  const sending = lease ? await head(workspace) : undefined;

  // The ref is named explicitly on both sides. A push that let git infer the
  // destination is a push that could land somewhere the server did not name.
  const attempt = (against: string | undefined) =>
    git(
      [
        "push",
        // The lease names the same full ref the destination does. A lease whose
        // refname does not match the ref being pushed is silently ignored, and
        // the push then degrades to the plain one this exists to replace.
        ...(against ? [`--force-with-lease=refs/heads/${repo.branch}:${against}`] : []),
        withToken(repo.url, repo.token),
        `HEAD:refs/heads/${repo.branch}`,
      ],
      workspace,
    );

  let { code, stderr } = await attempt(lease);

  if (code !== 0 && lease) {
    // cli#37: the keepalive pushes this same ref on its own timer, and its
    // push can land between the lease being read above and this one reaching
    // the remote - refused as stale, with the work already exactly where this
    // asked for it. A remote ahead of the lease with a commit this runner's
    // own history already contains (`HEAD` is built on top of it) is that
    // keepalive, and is recoverable: the lease is refreshed from the remote
    // and the same push retried once, rather than failing a round for a push
    // that only lost a race with itself. A remote ahead with a commit this
    // runner does not have is somebody else's, and stays refused rather than
    // forced over.
    const actual = await remoteHead(workspace, repo);
    const ownWork = actual !== undefined && (await mergeBase(actual, "HEAD", workspace)) === actual;
    if (ownWork && actual !== lease) {
      await git(["update-ref", LEASE_REF, actual], workspace);
      ({ code, stderr } = await attempt(actual));
    }
  }

  // The lease is what this Job knows the remote to hold, so a push that landed
  // moves it. Leaving it at the fetched tip is refused with `stale info` from
  // the second push onwards, and the keepalive pushes this ref every tick: the
  // Job would land tick one and then lose every push including its delivery.
  // Another runner's push in between is still a refusal, which is the point.
  if (code === 0 && sending) await git(["update-ref", LEASE_REF, sending], workspace);

  return { ok: code === 0, stderr };
}

export async function head(workspace: string): Promise<string | undefined> {
  return await capture(["rev-parse", "HEAD"], workspace);
}

/**
 * Whether the work is on the remote, which only the remote can answer.
 *
 * The push's exit code is deliberately not part of this. The keepalive pushes
 * the same ref the delivery does, and git rejects the loser of that race with
 * `incorrect old value provided` once the winner has put the commits exactly
 * where this asks for them. Failing on that exit code sends a Run to
 * `needs_human` with its work safely on the branch, which is this guard's own
 * scar inverted.
 *
 * Either side missing is a no: a remote that could not be read is never the same
 * as one that matches.
 */
export function onRemote(local: string | undefined, remote: string | undefined): boolean {
  return local !== undefined && local === remote;
}

/**
 * What `blocked.md` and the runner's own log say when `onRemote` refuses a
 * delivery. Git's own words when there are any, because "did not land" alone
 * left #314 needing its workspace hunted down to learn why; empty is not a
 * reason, so a push `onRemote` refused despite exiting zero (the keepalive won
 * a race this push believed it lost, or `remoteHead` itself could not be read)
 * still says something a person can act on.
 */
export function pushFailureMessage(commits: number, branch: string, stderr: string): string {
  const reason = stderr.trim() || "the push reported success but the remote does not show it";
  return `${commits} commit(s) exist locally and the push to ${branch} did not land: ${reason}. The work is on the runner and not on the remote, so this Job cannot be reported as complete.`;
}

/**
 * Rebases onto the base as it is right now, if it moved since this Job's own
 * clone and the rebase applies cleanly. crewbit-sh/crewbit-v2#328's server Job
 * is the fallback for a real conflict; this is the cheap path that keeps most
 * "behind main" refusals from firing at all — measured on #314, a 99-turn
 * code round refused for two docs pushes that landed while it was working.
 *
 * A conflict is left exactly as it was found: `--abort` restores the branch,
 * and the caller delivers as it would have anyway, letting the existing
 * behind-the-base refusal name it. This never pushes; the caller decides that.
 */
export async function rebaseOntoFreshBase(
  workspace: string,
  repo: Repo,
): Promise<{ rebased: boolean; conflict?: string }> {
  const fetched = await git(
    ["fetch", "--depth", "1", withToken(repo.url, repo.token), repo.baseBranch],
    workspace,
  );
  if (fetched.code !== 0) return { rebased: false };

  const freshBase = await commitAt("FETCH_HEAD", workspace);
  const oldBase = await commitAt(BASE_REF, workspace);
  if (!freshBase || !oldBase || freshBase === oldBase) return { rebased: false };

  // cli#39: read before the rebase moves HEAD. A rebase gives every replayed
  // commit a new sha, so the branch's own remote tip - whatever push put it
  // there, a keepalive tick or the one before the engine starts - is never an
  // ancestor of the rewritten history, and a fresh branch never holds a lease
  // to force the next push with (`pushed()` only advances one that already
  // exists, and never creates the first). Without this, that next push is
  // plain and refused as a false non-fast-forward the moment nothing else
  // happens to force it.
  const remoteTip = await remoteHead(workspace, repo);

  const rebased = await git(["rebase", "--onto", freshBase, oldBase, "HEAD"], workspace);
  if (rebased.code !== 0) {
    // crewbit-v2#328: the cheap in-band caller has a fallback (today's
    // "behind main" refusal) and never reads this; the server's own rebase
    // Job does not, and reports it the same way `pushed`'s own failure
    // carries git's words rather than a bare `false`.
    const conflict = rebased.stderr || "the rebase did not apply cleanly";
    await git(["rebase", "--abort"], workspace);
    return { rebased: false, conflict };
  }

  // `commitsSince`, `diffSince` and `changedFiles` all read from here: left at
  // the old base, the base's own new commit would count as this Job's work.
  await git(["update-ref", BASE_REF, freshBase], workspace);
  // `pushed()` forces with whatever this names, so the next push is a
  // legitimate `--force-with-lease` against exactly the tip the rebase
  // rewrote - and a foreign commit landing on the branch after this read
  // still refuses, the same as any other stale lease.
  if (remoteTip) await git(["update-ref", LEASE_REF, remoteTip], workspace);
  return { rebased: true };
}

/**
 * Whether a push that was refused nevertheless left the work on the remote.
 *
 * The keepalive pushes the same ref the first push does, so one of them loses
 * the race and git refuses it. Losing a race whose winner already put the
 * commit exactly where this asked for it is not the same failure as never
 * reaching the remote, and the exit code cannot tell them apart. The remote can.
 *
 * `deliver` has answered this question this way since the guard was written;
 * this is the same answer for the push that goes first.
 */
export async function alreadyOnRemote(workspace: string, repo: Repo): Promise<boolean> {
  return onRemote(await head(workspace), await remoteHead(workspace, repo));
}

/**
 * What the remote actually has on the branch, read from the remote.
 *
 * `undefined` means the question could not be answered, which is never the same
 * as "it matches": a remote that cannot be reached has to fail the guard.
 */
export async function remoteHead(workspace: string, repo: Repo): Promise<string | undefined> {
  const line = await capture(
    ["ls-remote", withToken(repo.url, repo.token), `refs/heads/${repo.branch}`],
    workspace,
  );
  return line?.split(/\s+/)[0] || undefined;
}

/** Stages everything and commits. False means there was nothing to commit. */
export async function commitAll(workspace: string, message: string): Promise<boolean> {
  await git(["add", "-A"], workspace);
  // `--allow-empty` is deliberately absent: an empty commit makes a Job look
  // like it produced work, and the PR is then a diff of nothing asking for
  // review.
  const { code } = await git(["commit", "-q", "-m", message], workspace);
  return code === 0;
}

/**
 * The commits this Job created, oldest first.
 *
 * Against the ref the workspace stamped rather than `origin/<base>`: the clone
 * has no remote, deliberately, so there is no remote-tracking ref to compare to.
 */
export async function commitsSince(workspace: string): Promise<string[]> {
  const out = await capture(["rev-list", "--reverse", `${BASE_REF}..HEAD`], workspace);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Where two refs last agreed, or undefined when the clone is too shallow to
 * know. Empty rather than an error is git's own answer, and the caller has to
 * treat it as "cannot tell" rather than as "nothing in common".
 */
export async function mergeBase(a: string, b: string, cwd: string): Promise<string | undefined> {
  return capture(["merge-base", a, b], cwd);
}

/**
 * The commit a ref names, or undefined when git could not resolve it.
 *
 * The fetched tip has to be read as a sha before anything else fetches, because
 * `FETCH_HEAD` is rewritten by the next fetch and answers with its first line:
 * a deepen that names the base branch first therefore turns `FETCH_HEAD` into
 * the base's tip. A sha read once cannot move under the caller.
 */
export async function commitAt(ref: string, cwd: string): Promise<string | undefined> {
  return (await capture(["rev-parse", "--verify", "--quiet", ref], cwd)) || undefined;
}

/**
 * How many commits `ref` carries that `base` does not, or undefined when git
 * could not say.
 *
 * Needs the history between the two, so a `--depth 1` clone has to be deepened
 * first: without it git either fails or answers about a graft point rather than
 * the base. Undefined rather than zero, because the caller has to tell "this
 * branch carries nothing" from "there was no answer" — only the first is grounds
 * for throwing a branch's tip away.
 */
export async function aheadOf(base: string, ref: string, cwd: string): Promise<number | undefined> {
  const out = await capture(["rev-list", "--count", `${base}..${ref}`], cwd);
  if (out === undefined) return undefined;
  const count = Number(out);
  return Number.isInteger(count) ? count : undefined;
}

/**
 * What this branch changed against the base it started from.
 *
 * `git diff A B` compares two trees and does not need the history between them,
 * which is what keeps the clone shallow.
 */
export async function diffSince(workspace: string): Promise<string | undefined> {
  return capture(["diff", `${BASE_REF}..HEAD`], workspace);
}

/**
 * The paths this branch changed against the base it started from, one per
 * line and empty when there are none - #10, for a server that has to tell
 * "touched only what it should" from "touched something else" without
 * reading the content of the change, and without asking a provider.
 */
export async function changedFiles(workspace: string): Promise<string | undefined> {
  return capture(["diff", "--name-only", `${BASE_REF}..HEAD`], workspace);
}

/**
 * What git tracks under a set of pathspecs, read out of the index.
 *
 * The index and not the worktree, which is what makes this answerable after the
 * files are gone: the caller removes directories wholesale and `skipWorktree`
 * takes index entries, so the names have to come from git rather than from a
 * walk of a tree that no longer has them.
 *
 * `-z` because a path is bytes: without it git quotes the awkward ones, and a
 * quoted name is not the name the index holds.
 */
export async function trackedUnder(workspace: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const out = await captureRaw(["ls-files", "-z", "--", ...paths], workspace);
  return out ? out.split("\0").filter(Boolean) : [];
}

/** `.git/info/exclude` stops `git add -A` from ever staging these; #384 measured Copilot committing `reading.md` anyway. */
export async function untrackPaperwork(workspace: string, names: string[]): Promise<void> {
  const tracked = await trackedUnder(workspace, names);
  if (tracked.length === 0) return;
  await git(["rm", "--cached", "-q", "--", ...tracked], workspace);
}

/**
 * Tells git to stop comparing these paths against the worktree.
 *
 * Reports rather than throws, the way `git()` does: the caller decides, and
 * here it decides to fail the Job. A path removed from the worktree but left in
 * the index reads as a deletion, so `git add -A` in a writing Stage stages it
 * and the pull request deletes the repository's own agents, skills and
 * settings — 44 of them on the Run this was measured on.
 */
export async function skipWorktree(workspace: string, paths: string[]): Promise<GitRun> {
  return git(["update-index", "--skip-worktree", "--", ...paths], workspace);
}

/**
 * The grant travels in the url, which is how git takes a token over HTTPS. A
 * local path or an empty token is left alone, so a test can use a directory.
 */
export function withToken(url: string, token: string): string {
  if (!token || !url.startsWith("https://")) return url;
  return url.replace("https://", `https://x-access-token:${token}@`);
}

export type GitRun = {
  code: number;
  /** Whatever git wrote, credential removed and bounded. Empty when it worked. */
  stderr: string;
};

/**
 * Runs git and keeps what it said.
 *
 * The exit code alone is not diagnosable: a Job died on `could not clone (git
 * exited 128)` and there was no way to tell authentication from network from
 * disk, because the message git wrote had been thrown away.
 *
 * **The redaction is here rather than at the caller**, because git echoes back
 * the url it was handed and that url carries the token:
 * `fatal: Authentication failed for 'https://x-access-token:TOKEN@host/'`. One
 * chokepoint is a guarantee; each caller remembering is a leak waiting for the
 * one that forgets.
 */
export function git(args: string[], cwd: string): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: gitEnv() });
    let said = "";
    child.stderr.on("data", (chunk) => {
      said += chunk;
    });
    child.on("error", (cause) => resolve({ code: 1, stderr: redact(cause.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr: redact(said) }));
  });
}

/**
 * The tail rather than the head: git puts the useful line last, and the server
 * refuses a completion over a megabyte, so an unbounded stderr from an external
 * process could fail the whole Job rather than explain it.
 */
const MAX_STDERR = 2000;

/**
 * `https://user:token@host` is how a credential reaches git and how git hands it
 * back. Measured on git 2.x: `unable to access` strips the userinfo and
 * `Authentication failed for` does not, and the second is the message that
 * matters, because it is the one a bad token produces.
 */
const CREDENTIAL_IN_URL = /https:\/\/[^@\s/]*@/g;

export function redact(said: string): string {
  const clean = said.replace(CREDENTIAL_IN_URL, "https://").trim();
  return clean.length > MAX_STDERR ? clean.slice(-MAX_STDERR) : clean;
}

async function capture(args: string[], cwd: string): Promise<string | undefined> {
  const out = await captureRaw(args, cwd);
  return out === undefined ? undefined : out.trim();
}

/**
 * Untrimmed, for the output whose separator is not whitespace: trimming a
 * `-z` listing eats a leading space that is part of the first path's name.
 */
async function captureRaw(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? out : undefined));
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Without this a lapsed token blocks forever on a password prompt instead of
    // failing, and the lease then reclaims a Job that is not actually running.
    GIT_TERMINAL_PROMPT: "0",
    // The workspace carries its own identity. Refusing the ambient one is what
    // keeps a commit from being attributed to whoever owns the machine.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}
