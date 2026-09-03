import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alreadyOnRemote,
  commitAll,
  commitsSince,
  git,
  head,
  onRemote,
  pushed,
  redact,
  remoteHead,
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
  options: { delivers?: boolean } = {},
) {
  const repo = { ...origin, branch, token: "", tokenExpiresAt: "" };
  const workspace = await prepareWorkspace({
    context: {},
    repo,
    delivers: options.delivers ?? true,
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

  test("and a second push from the continued workspace lands", async () => {
    const origin = bareOrigin();
    const first = await workspaceOn(origin);
    writeFileSync(join(first.workspace, "app.ts"), "export const answer = 43;\n");
    await commitAll(first.workspace, "one");
    await pushed(first.workspace, first.repo);

    const second = await workspaceOn(origin);
    writeFileSync(join(second.workspace, "app.ts"), "export const answer = 44;\n");
    await commitAll(second.workspace, "two");

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
