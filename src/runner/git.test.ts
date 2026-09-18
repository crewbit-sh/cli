import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aheadOf,
  alreadyOnRemote,
  BASE_REF,
  changedFiles,
  commitAll,
  commitAt,
  commitsSince,
  git,
  head,
  onRemote,
  pushed,
  pushFailureMessage,
  rebaseOntoFreshBase,
  redact,
  remoteHead,
  trackedUnder,
  untrackPaperwork,
  withToken,
} from "./git.ts";
import { prepareWorkspace } from "./workspace.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const sh = (args: string[], cwd: string) => spawnSync("git", args, { cwd, stdio: "ignore" });

/**
 * A bare remote, which is what a push actually goes to. A non-bare one refuses a
 * push to its checked-out branch, and that difference is not something to
 * discover later against a real repository.
 */
function bareOrigin(): { url: string; baseBranch: string } {
  const bare = scratch("crewbit-origin-");
  rmSync(bare, { recursive: true, force: true });
  cpSync(template(), bare, { recursive: true });
  return { url: bare, baseBranch: "main" };
}

/**
 * The one this file copies from.
 *
 * Building a remote costs six git processes, which is 743ms on a Mac where the
 * shell's git is ad-hoc signed and revalidated on every exec; copying a
 * prebuilt one is 4ms. Thirty-one tests each own an independent repository
 * either way, so nothing about the isolation changes.
 *
 * Built on first use and kept for the process, because `dirs` is emptied after
 * every test.
 */
let prebuilt: string | undefined;

function template(): string {
  if (prebuilt) return prebuilt;
  const seed = mkdtempSync(join(tmpdir(), "crewbit-template-seed-"));
  writeFileSync(join(seed, "app.ts"), "export const answer = 42;\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t.test"],
    ["config", "user.name", "t"],
    ["add", "."],
    ["commit", "-qm", "first"],
  ]) {
    sh(args, seed);
  }

  const bare = mkdtempSync(join(tmpdir(), "crewbit-template-"));
  spawnSync("git", ["clone", "--bare", "-q", seed, bare], { stdio: "ignore" });
  // The clone recorded the seed's path as `origin`. Nothing fetches from these
  // remotes, and a copy pointing at a directory that is gone reads as a fixture
  // bug the first time somebody does.
  spawnSync("git", ["--git-dir", bare, "remote", "remove", "origin"], { stdio: "ignore" });
  // receive-pack answers the push and only then runs `gc --auto`, detached,
  // without the pusher waiting on it. A test that deletes this directory right
  // after pushing can catch that orphaned gc process mid-write and find the
  // "deleted" repo whole again: reproduced on CI under full-suite load, where
  // gc has enough time to lose the race. Every copy of this template inherits
  // the setting, since it lives in the bare repo's own config.
  spawnSync("git", ["--git-dir", bare, "config", "gc.auto", "0"], { stdio: "ignore" });
  rmSync(seed, { recursive: true, force: true });
  prebuilt = bare;
  return bare;
}

async function workspaceOn(
  origin: { url: string; baseBranch: string },
  branch = "crewbit/spec-1",
  options: { delivers?: boolean; artifacts?: string[] } = {},
) {
  const repo = { ...origin, branch, token: "", tokenExpiresAt: "" };
  const workspace = await prepareWorkspace({
    context: {},
    repo,
    delivers: options.delivers ?? true,
    artifacts: options.artifacts,
  });
  dirs.push(workspace);
  return { workspace, repo };
}

describe("pushing", () => {
  test("puts the branch on the remote before the agent has written anything", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);

    expect((await pushed(workspace, repo)).ok).toBe(true);

    // A runner that dies on its first turn then leaves a branch behind, and the
    // next attempt is a fetch rather than an archaeology.
    expect(await remoteHead(workspace, repo)).toBe(await head(workspace));
  });

  test("carries each commit as it is made, not only at the end", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);

    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "first change");
    await pushed(workspace, repo);
    const afterFirst = await remoteHead(workspace, repo);

    writeFileSync(join(workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(workspace, "second change");

    // The second is committed and not yet pushed, which is what being killed
    // here would look like: one commit lost, not both.
    expect(afterFirst).not.toBe(await head(workspace));
    expect(await remoteHead(workspace, repo)).toBe(afterFirst);
  });

  test("reports failure rather than throwing, because the caller has to decide", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    rmSync(repo.url, { recursive: true, force: true });

    expect((await pushed(workspace, repo)).ok).toBe(false);
  });

  /**
   * The reason travels with the refusal, because the caller cannot ask again:
   * a Job that dies on its first push reported "could not push <branch> before
   * starting" and nothing else, and what git actually said — a remote that is
   * not there, a ref that already exists, a rejected non-fast-forward — is the
   * whole of the difference between a fixture bug and a credential one.
   */
  test("says what git said, so the failure is diagnosable from the report alone", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    rmSync(repo.url, { recursive: true, force: true });

    const { ok, stderr } = await pushed(workspace, repo);

    expect(ok).toBe(false);
    expect(stderr).toContain("does not appear to be a git repository");
  });
});

describe("a refused push that landed anyway", () => {
  /**
   * The keepalive pushes the same ref the first push does, and git refuses the
   * loser of that race. Losing a race the winner already finished is not the
   * same failure as not reaching the remote, and only the remote can tell them
   * apart.
   */
  test("says yes when the remote already carries the commit", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);

    expect(await alreadyOnRemote(workspace, repo)).toBe(true);
  });

  test("says no when the remote is behind, which is work that did not reach it", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "not pushed");

    expect(await alreadyOnRemote(workspace, repo)).toBe(false);
  });

  test("says no when the remote cannot be read at all", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);
    rmSync(repo.url, { recursive: true, force: true });

    // A remote that cannot answer is never a remote that agrees, or the guard
    // is nobody: an unreachable remote would read as work safely delivered.
    expect(await alreadyOnRemote(workspace, repo)).toBe(false);
  });
});

describe("the push guard", () => {
  test("agrees when the remote actually has the work", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "work");
    await pushed(workspace, repo);

    expect(await remoteHead(workspace, repo)).toBe(await head(workspace));
  });

  test("disagrees when commits exist locally and the remote is behind", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "work nobody pushed");

    // This is the state that must never be reported as complete: the PR would be
    // marked ready missing exactly this commit, and the fix loop would then
    // repeat forever on a criterion the code satisfies.
    expect(await remoteHead(workspace, repo)).not.toBe(await head(workspace));
  });

  test("reads the remote, so a push that lied about succeeding is caught", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "work");
    await pushed(workspace, repo);

    // Rewinding the remote branch to the base is what a push reporting success
    // and leaving the remote behind looks like from here. Nothing local changes.
    // `HEAD~1` would not do it: in a bare repository HEAD is the default branch,
    // not the one being pushed.
    sh(["update-ref", `refs/heads/${repo.branch}`, `refs/heads/${repo.baseBranch}`], repo.url);

    expect(await remoteHead(workspace, repo)).not.toBe(await head(workspace));
  });

  test("a remote that cannot be reached is not silently treated as matching", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);
    // `force` is deliberately absent, and the existence check is not redundant
    // with it. This failed once on a macOS runner with a real SHA back, which
    // reads as `remoteHead` being broken and is indistinguishable from the
    // remote never having been removed. `force` would have swallowed the second
    // one. Whichever it is next time, it now says which.
    rmSync(repo.url, { recursive: true });
    expect(existsSync(repo.url)).toBe(false);

    expect(await remoteHead(workspace, repo)).toBeUndefined();
  });

  /**
   * The three reads above are what the guard is built from; this is the guard
   * itself, which had no test and was wrong.
   */
  test("the remote holding the work is delivery, whatever the push exited with", () => {
    // What a lost push race leaves behind: the keepalive won, the delivery push
    // exited non-zero with `incorrect old value provided`, and the commits are
    // exactly where this asks for them.
    expect(onRemote("abc123", "abc123")).toBe(true);
  });

  test("a remote behind the work is not delivery", () => {
    expect(onRemote("abc123", "def456")).toBe(false);
  });

  test("a remote that could not be read is not delivery", () => {
    expect(onRemote("abc123", undefined)).toBe(false);
  });

  test("no local head is not delivery either, so two unknowns never agree", () => {
    expect(onRemote(undefined, undefined)).toBe(false);
  });
});

describe("cli#37: a stale lease left by this runner's own keepalive", () => {
  /**
   * The keepalive pushes the same ref a later push does, on its own timer,
   * independently of that later push's own lease read. Landing that push
   * directly rather than through `pushed()` reproduces exactly the drift a
   * race between the two would leave: `real`'s own lease still names the tip
   * it cloned from, one commit behind what is actually on the remote.
   */
  test("a lease behind this runner's own later commit is refreshed and retried", async () => {
    const origin = bareOrigin();

    const seed = await workspaceOn(origin);
    writeFileSync(join(seed.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(seed.workspace, "seed work");
    await pushed(seed.workspace, seed.repo);

    // A resumed round: the clone continues the branch it already has commits
    // on, and holds a lease at that tip.
    const real = await workspaceOn(origin);

    writeFileSync(join(real.workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(real.workspace, "round work 1");
    sh(["push", origin.url, `HEAD:refs/heads/${real.repo.branch}`], real.workspace);

    writeFileSync(join(real.workspace, "app.ts"), "export const answer = 45;\n");
    await commitAll(real.workspace, "round work 2");

    const result = await pushed(real.workspace, real.repo);

    expect(result.ok).toBe(true);
    expect(await remoteHead(real.workspace, real.repo)).toBe(await head(real.workspace));
  });

  /**
   * A remote ahead of the lease is not always this runner's own keepalive: it
   * can be another actor's commit this runner never made and does not have.
   * Forcing over it would be the exact loss the lease exists to prevent, so
   * this stays refused rather than retried.
   */
  test("a remote ahead with a commit this runner does not have stays refused", async () => {
    const origin = bareOrigin();

    const seed = await workspaceOn(origin);
    writeFileSync(join(seed.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(seed.workspace, "seed work");
    await pushed(seed.workspace, seed.repo);

    const real = await workspaceOn(origin);
    const foreign = await workspaceOn(origin);
    writeFileSync(join(foreign.workspace, "other.ts"), "export const other = 1;\n");
    await commitAll(foreign.workspace, "foreign work");
    sh(["push", origin.url, `HEAD:refs/heads/${foreign.repo.branch}`], foreign.workspace);

    writeFileSync(join(real.workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(real.workspace, "real work");

    const result = await pushed(real.workspace, real.repo);

    expect(result.ok).toBe(false);
  });
});

describe("what a person reads when the guard fails a Job", () => {
  test("carries git's own reason, the way the pre-round push already does", () => {
    const message = pushFailureMessage(4, "crewbit/spec-314", "! [rejected] (stale info)\n");

    expect(message).toContain("4 commit(s)");
    expect(message).toContain("crewbit/spec-314");
    expect(message).toContain("stale info");
  });

  test("says so even when the push itself reported success", () => {
    // The keepalive can win a race the delivery push believes it lost, or
    // `remoteHead` can be the one that failed to read - either way `pushed()`
    // has no git error to carry, and empty is not a reason.
    const message = pushFailureMessage(2, "crewbit/spec-9", "");

    expect(message).toContain("2 commit(s)");
    expect(message).not.toContain(": .");
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("what the Job reports back", () => {
  test("the commits it made, and not the ones it started from", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "one");
    writeFileSync(join(workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(workspace, "two");

    const made = await commitsSince(workspace);

    expect(made).toHaveLength(2);
    expect(made[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  test("nothing, when the agent wrote nothing", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    expect(await commitsSince(workspace)).toEqual([]);
  });

  test("nothing to commit is not a commit", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    // An empty commit would make a Job look like it produced work, and the PR
    // would then be a diff of nothing asking for review.
    expect(await commitAll(workspace, "nothing changed")).toBe(false);
    expect(await commitsSince(workspace)).toEqual([]);
  });
});

describe("untrackPaperwork", () => {
  test("un-stages this Job's own files even after an engine committed them anyway", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    // Measured on #384's code stage under --engine copilot-cli: `.git/info/exclude`
    // named both files, and Copilot committed `reading.md` in the same commit as
    // the real change anyway.
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    writeFileSync(join(workspace, "reading.md"), "how I read the spec\n");
    await commitAll(workspace, "the change, with the paperwork alongside it");

    await untrackPaperwork(workspace, ["pr-body.md", "reading.md"]);

    expect(await trackedUnder(workspace, ["reading.md"])).toEqual([]);
    // Still tracked: this never touches a file the diff actually needs.
    expect(await trackedUnder(workspace, ["app.ts"])).toEqual(["app.ts"]);
    // Still on disk: the Stage reads it back as an artifact after the Job ends.
    expect(readFileSync(join(workspace, "reading.md"), "utf8")).toBe("how I read the spec\n");
  });

  test("does nothing when none of the named files are tracked", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);
    const before = await head(workspace);

    await untrackPaperwork(workspace, ["pr-body.md", "reading.md"]);

    expect(await head(workspace)).toBe(before);
  });

  test("the removal is what the ordinary commit picks up", async () => {
    const origin = bareOrigin();
    // `artifacts` is what `deliver` really passes: `.git/info/exclude` already
    // names `pr-body.md`, so `git add -A` below does not put it straight back.
    const { workspace } = await workspaceOn(origin, "crewbit/spec-1", {
      artifacts: ["pr-body.md"],
    });
    writeFileSync(join(workspace, "pr-body.md"), "done\n");
    // `-f`: the exclude above refuses a plain `add`, the same way Copilot's own
    // tool walked past it on #384.
    await git(["add", "-f", "pr-body.md"], workspace);
    await git(["commit", "-q", "-m", "the agent's own commit"], workspace);

    await untrackPaperwork(workspace, ["pr-body.md"]);
    expect(await commitAll(workspace, "crewbit: work in progress for code")).toBe(true);
    expect(await trackedUnder(workspace, ["pr-body.md"])).toEqual([]);
  });
});

describe("the clone the agent gets", () => {
  test("carries no credential on disk", async () => {
    const origin = bareOrigin();
    const repo = {
      ...origin,
      branch: "crewbit/spec-1",
      token: "ghs_secret_token",
      tokenExpiresAt: "",
    };
    // An https url is what a real grant looks like, and cloning it would need the
    // network, so the clone url stays local while the token is still supplied.
    const workspace = await prepareWorkspace({ context: {}, repo: { ...repo, token: "" } });
    dirs.push(workspace);

    const config = readFileSync(join(workspace, ".git", "config"), "utf8");

    // `git clone` records the url it was given, token and all. An agent with Bash
    // reads it with `cat .git/config`, so the remote does not survive the clone.
    expect(config).not.toContain("ghs_secret_token");
    expect(config).not.toContain("[remote");
  });

  test("has nowhere to push, which is what actually stops the agent pushing", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    // Enforced by git rather than by matching command strings: measured on
    // claude 2.1.222, `--disallowed-tools "Bash(git push:*)"` does not deny a
    // Bash subcommand while Bash is allowed.
    const code = spawnSync("git", ["push"], { cwd: workspace, stdio: "ignore" }).status;

    expect(code).not.toBe(0);
  });

  test("still lets the runner push, because it names the destination itself", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);

    expect((await pushed(workspace, repo)).ok).toBe(true);
    expect(await remoteHead(workspace, repo)).toBe(await head(workspace));
  });

  test("knows where the work started without a remote to compare against", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "one");

    expect(await commitsSince(workspace)).toHaveLength(1);
  });
});

describe("a workspace for work that already started", () => {
  test("continues the branch instead of starting it over", async () => {
    const origin = bareOrigin();
    // A first runner did some work and pushed it.
    const first = await workspaceOn(origin);
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "work from the runner that died");
    await pushed(first.workspace, first.repo);
    const landed = await head(first.workspace);

    // A second runner is handed the same Job.
    const second = await workspaceOn(origin);

    // Without this it clones the base, creates the branch again, and its push is
    // a non-fast-forward the guard then fails: a retry that cannot ever succeed.
    expect(await head(second.workspace)).toBe(landed);
    expect(readFileSync(join(second.workspace, "app.ts"), "utf8")).toContain("43");
  });

  test("still knows where the work started, so the diff is the work and not everything", async () => {
    const origin = bareOrigin();
    const first = await workspaceOn(origin);
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "one");
    await pushed(first.workspace, first.repo);

    const second = await workspaceOn(origin);

    // The base ref points at the base branch, not at whatever HEAD happens to be.
    expect(await commitsSince(second.workspace)).toHaveLength(1);
  });

  test("creates the branch when the remote has never seen it", async () => {
    const origin = bareOrigin();

    const { workspace } = await workspaceOn(origin, "crewbit/brand-new");

    // The first round of every Run, which must not become a fetch failure.
    expect(await commitsSince(workspace)).toEqual([]);
    expect(readFileSync(join(workspace, "app.ts"), "utf8")).toContain("42");
  });

  /**
   * The keepalive pushes this same ref on every tick, so the second push of a
   * Job is the ordinary case and not a corner. A lease fixed to the tip the
   * clone fetched is refused with `stale info` from the second push onwards,
   * which would land tick one, lose every tick after it, and then lose the
   * delivery of work that is real and one push away.
   */
  test("and pushes again after committing again, so every tick after the first still lands", async () => {
    const origin = bareOrigin();
    const first = await workspaceOn(origin);
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "one");
    await pushed(first.workspace, first.repo);

    const second = await workspaceOn(origin);
    writeFileSync(join(second.workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(second.workspace, "two");
    expect((await pushed(second.workspace, second.repo)).ok).toBe(true);

    writeFileSync(join(second.workspace, "app.ts"), "export const answer = 45;\n");
    await commitAll(second.workspace, "three");

    expect((await pushed(second.workspace, second.repo)).ok).toBe(true);
    expect(await remoteHead(second.workspace, second.repo)).toBe(await head(second.workspace));
  });
});

describe("what a commit must not sweep up", () => {
  test("leaves the Job's own context files out of the repository", async () => {
    const origin = bareOrigin();
    const repo = { ...origin, branch: "crewbit/spec-1", token: "", tokenExpiresAt: "" };
    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem", "plan.md": "## Plan", "repo-map.md": "# Repo map" },
      repo,
    });
    dirs.push(workspace);

    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(workspace, "the agent's work");

    // `git add -A` from the workspace root sees them, because the workspace root
    // is the clone. Committing the Job's own briefing into the repository being
    // worked on would put spec.md and plan.md in the pull request.
    const tracked = spawnSync("git", ["ls-files"], { cwd: workspace, encoding: "utf8" }).stdout;
    expect(tracked).toContain("app.ts");
    expect(tracked).not.toContain("spec.md");
    expect(tracked).not.toContain("plan.md");
    expect(tracked).not.toContain("repo-map.md");
  });

  test("and the agent can still read them, which is the whole point of them", async () => {
    const origin = bareOrigin();
    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem\nreadable" },
      repo: { ...origin, branch: "crewbit/spec-1", token: "", tokenExpiresAt: "" },
    });
    dirs.push(workspace);

    expect(readFileSync(join(workspace, "spec.md"), "utf8")).toContain("readable");
  });
});

describe("the diff a reviewer reads", () => {
  test("is the branch against the base, not the whole repository", async () => {
    const origin = bareOrigin();
    const first = await workspaceOn(origin);
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "raise it");
    await pushed(first.workspace, first.repo);

    // What an eval Job gets: a fresh clone of the branch, nothing of its own.
    const { workspace } = await workspaceOn(origin);

    const diff = readFileSync(join(workspace, "diff.md"), "utf8");
    expect(diff).toContain("app.ts");
    expect(diff).toContain("43");
    // README.md is in the repository and untouched, so it is not the diff.
    expect(diff).not.toContain("a repository");
  });

  test("is not written when there is nothing to diff", async () => {
    const origin = bareOrigin();

    const { workspace } = await workspaceOn(origin, "crewbit/nothing-yet");

    // An empty file would read as "the change is empty" rather than "no change".
    expect(existsSync(join(workspace, "diff.md"))).toBe(false);
  });

  test("does not become part of the commit it describes", async () => {
    const origin = bareOrigin();
    const first = await workspaceOn(origin);
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "raise it");
    await pushed(first.workspace, first.repo);

    const second = await workspaceOn(origin);
    writeFileSync(join(second.workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(second.workspace, "again");

    const tracked = spawnSync("git", ["ls-files"], {
      cwd: second.workspace,
      encoding: "utf8",
    }).stdout;
    expect(tracked).not.toContain("diff.md");
  });
});

describe("the files a branch changed, #10", () => {
  test("names two added files and one modified one, and nothing untouched", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    writeFileSync(join(workspace, "new-one.ts"), "export const one = 1;\n");
    writeFileSync(join(workspace, "new-two.ts"), "export const two = 2;\n");
    await commitAll(workspace, "two new files and one changed");

    const changed = (await changedFiles(workspace))?.split("\n") ?? [];

    expect(changed.sort()).toEqual(["app.ts", "new-one.ts", "new-two.ts"]);
  });

  test("is empty when the branch changed nothing", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    expect(await changedFiles(workspace)).toBe("");
  });
});

describe("a stage that only reads", () => {
  test("gets the base branch, not the snapshot an earlier Job left behind", async () => {
    const origin = bareOrigin();
    // A delivering Job pushed a branch, at whatever the base was then.
    const first = await workspaceOn(origin, "crewbit/spec-1", { delivers: true });
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "work");
    await pushed(first.workspace, first.repo);
    // The base moves on, as `main` does while a Spec waits.
    sh(["update-ref", "refs/heads/main", "refs/heads/main"], origin.url);

    const reader = await workspaceOn(origin, "crewbit/spec-1", { delivers: false });

    // Checking the branch out would freeze this Spec at the first Job's tree:
    // it happened, and two re-planned Specs produced refusals byte-identical to
    // their first ones, still describing a repository from two hours earlier.
    expect(readFileSync(join(reader.workspace, "app.ts"), "utf8")).toContain("42");
  });

  test("and a delivering stage still continues the branch", async () => {
    const origin = bareOrigin();
    const first = await workspaceOn(origin, "crewbit/spec-1", { delivers: true });
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "work");
    await pushed(first.workspace, first.repo);

    const second = await workspaceOn(origin, "crewbit/spec-1", { delivers: true });

    // A fix round and a second runner both need this, and it is what the eval
    // reads. Only the reading stages lose it.
    expect(readFileSync(join(second.workspace, "app.ts"), "utf8")).toContain("43");
  });
});

describe("how far ahead of the base a ref is", () => {
  test("is the number of commits for a ref ahead of it, and zero for one behind", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);
    for (const answer of [43, 44]) {
      writeFileSync(join(workspace, "app.ts"), `export const answer = ${answer};\n`);
      await commitAll(workspace, `work ${answer}`);
    }

    // The question #20 wanted and could not afford: how many commits does this
    // ref carry that the base does not.
    expect(await aheadOf(BASE_REF, "HEAD", workspace)).toBe(2);
    // And none the other way round: the base is an ancestor of HEAD, so it is
    // ahead by nothing. Zero is the only answer that starts a Stage fresh.
    expect(await aheadOf("HEAD", BASE_REF, workspace)).toBe(0);
  });

  test("is undefined, not zero, for a ref git cannot resolve", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin, "crewbit/brand-new");

    // `FETCH_HEAD` in a clone that never fetched. The caller continues a branch
    // on "cannot tell" and starts fresh only on a zero it actually read, so the
    // two must not arrive as the same value.
    expect(await aheadOf(BASE_REF, "FETCH_HEAD", workspace)).toBeUndefined();
  });
});

describe("resolving a ref to the commit it names", () => {
  test("is the sha git itself reports", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin);

    // The tip is read as a sha before the deepen fetch overwrites `FETCH_HEAD`,
    // which is why this exists rather than the ref name being carried forward.
    expect(await commitAt("HEAD", workspace)).toBe(await head(workspace));
  });

  test("is undefined for a ref git cannot resolve, rather than an empty string", async () => {
    const origin = bareOrigin();
    const { workspace } = await workspaceOn(origin, "crewbit/brand-new");

    expect(await commitAt("FETCH_HEAD", workspace)).toBeUndefined();
  });
});

describe("what git said when it failed", () => {
  test("comes back with the exit code, so a failure is diagnosable at all", async () => {
    const dir = scratch("crewbit-git-");

    const { code, stderr } = await git(["clone", "https://127.0.0.1:1/nope.git", "."], dir);

    // A Job died on `git exited 128` with no way to tell authentication from
    // network from disk, because the runner spawned git with stdio ignored.
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("a command that worked reports zero and nothing to say", async () => {
    const dir = scratch("crewbit-git-");

    expect((await git(["init", "-q"], dir)).code).toBe(0);
  });
});

describe("taking the credential out of what git said", () => {
  // Driven as a function rather than through a real failure: the message that
  // carries the token is the authentication one, and there is no way to provoke
  // that offline. Going through `git()` against an unreachable host asserted the
  // absence of a token git had already stripped itself, which is a test that
  // cannot fail.
  const url = withToken("https://github.com/acme/api.git", "ghp_thisisasecret");

  test("the message a bad token actually produces", () => {
    const said = redact(`fatal: Authentication failed for '${url}/'`);

    expect(said).not.toContain("ghp_thisisasecret");
    expect(said).not.toContain("x-access-token");
    // The repository is the half worth keeping: it says which clone failed.
    expect(said).toContain("github.com/acme/api.git");
  });

  test("every occurrence, not the first", () => {
    const said = redact(`unable to access '${url}'\nAuthentication failed for '${url}'`);

    expect(said).not.toContain("ghp_thisisasecret");
  });

  test("a message with no credential in it is left alone", () => {
    expect(redact("fatal: not a git repository")).toBe("fatal: not a git repository");
  });

  test("keeps the tail, because git puts the useful line last", () => {
    const said = redact(`${"noise\n".repeat(2000)}fatal: the last line`);

    // The server refuses a completion over a megabyte, so an unbounded stderr
    // from an external process could fail the Job rather than explain it.
    expect(said.length).toBeLessThanOrEqual(2000);
    expect(said).toContain("fatal: the last line");
  });
});

/**
 * Advances the base out of band, the way another push during a long round
 * does: a separate clone, a commit, a push, nothing this Job's own workspace
 * knows about until it asks.
 */
function advanceBase(
  origin: { url: string; baseBranch: string },
  changes: Record<string, string>,
): void {
  const dir = scratch("crewbit-advance-");
  sh(["clone", "-q", origin.url, dir], ".");
  for (const [name, content] of Object.entries(changes)) writeFileSync(join(dir, name), content);
  sh(["add", "."], dir);
  sh(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "docs"], dir);
  sh(["push", "-q", "origin", `HEAD:${origin.baseBranch}`], dir);
}

describe("rebasing onto a base that moved during the round", () => {
  /**
   * cli#4/crewbit-v2#328: measured on #314, a 99-turn code round delivered
   * four commits and was refused for being two commits behind main, because
   * two docs pushes landed while it was still working. This is the cheap path
   * that makes that refusal fire only on a real conflict: #328's server
   * Job, dispatched with no engine, is the fallback rather than the norm.
   */
  test("replays this Job's own commits onto the fresh base when there is no conflict", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);

    // This round's own work, on the base as it was at clone time.
    writeFileSync(join(workspace, "feature.ts"), "export const feature = 1;\n");
    await commitAll(workspace, "add the feature");

    // The base the round started from is not the base anymore.
    advanceBase(origin, { "README.md": "# a repository\nupdated\n" });

    const result = await rebaseOntoFreshBase(workspace, repo);

    expect(result.rebased).toBe(true);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toContain("updated");
    expect(readFileSync(join(workspace, "feature.ts"), "utf8")).toContain("feature = 1");
    // BASE_REF moved with it: the base's own commit does not count as this
    // Job's, or `changed-files.txt` would name a file this Job never touched.
    expect(await commitsSince(workspace)).toHaveLength(1);
  });

  test("leaves the branch exactly as it was when the rebase would conflict", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);

    writeFileSync(join(workspace, "app.ts"), "export const answer = 100;\n");
    await commitAll(workspace, "change app.ts");
    const beforeRebase = await head(workspace);

    // The base changes the same line this round's own commit did.
    advanceBase(origin, { "app.ts": "export const answer = 200;\n" });

    const result = await rebaseOntoFreshBase(workspace, repo);

    expect(result.rebased).toBe(false);
    expect(await head(workspace)).toBe(beforeRebase);
    expect(readFileSync(join(workspace, "app.ts"), "utf8")).toContain("answer = 100");
    // No half-finished rebase left for the push or the next command to trip
    // over: today's guard refuses this exactly as it already refuses a branch
    // behind main, which is what a conflict here still is.
    expect(existsSync(join(workspace, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(workspace, ".git", "rebase-apply"))).toBe(false);
  });

  /**
   * crewbit-v2#328: the cheap in-band caller ignores this and falls back to
   * today's "behind main" refusal, but the server's own rebase Job has no
   * other work to fall back to - it has to say why, the same way `pushed`'s
   * own failure carries git's words rather than a bare `false`.
   */
  test("names what git said, so a rebase Job with nothing else to fall back to can report why", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);

    writeFileSync(join(workspace, "app.ts"), "export const answer = 100;\n");
    await commitAll(workspace, "change app.ts");
    advanceBase(origin, { "app.ts": "export const answer = 200;\n" });

    const result = await rebaseOntoFreshBase(workspace, repo);

    expect(result.rebased).toBe(false);
    expect(result.conflict).toBeTruthy();
    expect(result.conflict).toContain("app.ts");
  });

  test("does nothing when the base has not moved, so an unrelated round pays only the fetch", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    const before = await head(workspace);

    const result = await rebaseOntoFreshBase(workspace, repo);

    expect(result.rebased).toBe(false);
    expect(await head(workspace)).toBe(before);
    // Nothing rewrote the branch, so nothing needs forcing over what a plain
    // push already reaches as a fast-forward.
    const pushedResult = await pushed(workspace, repo);
    expect(pushedResult.ok).toBe(true);
  });

  /**
   * cli#39: a fresh branch never holds a lease - `pushed()` only advances one
   * that already exists, and never creates the first (git.ts:46,90) - so a
   * round with no keepalive tick reaches this rebase with none either way.
   * Once something (the pre-round push, a keepalive tick, this test standing
   * in for either) has put this Job's own un-rebased commit on the remote,
   * the rebase above rewrites it into a sibling with a different sha, and a
   * plain push of that sibling is a genuine non-fast-forward against a
   * remote tip that is this runner's own work and not somebody else's.
   */
  test("a push after a clean rebase forces with the lease it read before rewriting, with no keepalive lease", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);

    // The pre-round push: puts the branch on the remote before the engine
    // writes anything. No lease yet - a fresh branch holds none.
    await pushed(workspace, repo);

    writeFileSync(join(workspace, "feature.ts"), "export const feature = 1;\n");
    await commitAll(workspace, "add the feature");
    // This Job's own commit reaches the remote before the rebase - a
    // keepalive tick in production, a second call here. Still no lease.
    await pushed(workspace, repo);

    advanceBase(origin, { "README.md": "# a repository\nupdated\n" });

    const rebase = await rebaseOntoFreshBase(workspace, repo);
    expect(rebase.rebased).toBe(true);

    const result = await pushed(workspace, repo);

    expect(result.ok).toBe(true);
    expect(await remoteHead(workspace, repo)).toBe(await head(workspace));
  });

  test("a foreign commit landing on the branch after the rebase's read still refuses", async () => {
    const origin = bareOrigin();
    const { workspace, repo } = await workspaceOn(origin);
    await pushed(workspace, repo);

    writeFileSync(join(workspace, "feature.ts"), "export const feature = 1;\n");
    await commitAll(workspace, "add the feature");
    await pushed(workspace, repo);

    advanceBase(origin, { "README.md": "# a repository\nupdated\n" });
    const rebase = await rebaseOntoFreshBase(workspace, repo);
    expect(rebase.rebased).toBe(true);

    // Lands on this Job's own branch after the rebase read the tip it forces
    // against - not this runner's own history, so the lease refuses it
    // rather than forcing over it.
    const foreign = await workspaceOn(origin);
    writeFileSync(join(foreign.workspace, "other.ts"), "export const other = 1;\n");
    await commitAll(foreign.workspace, "foreign work");
    sh(["push", origin.url, `HEAD:refs/heads/${repo.branch}`], foreign.workspace);

    const result = await pushed(workspace, repo);

    expect(result.ok).toBe(false);
  });
});
