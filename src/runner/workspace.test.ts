import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "../log.ts";
import { alreadyOnRemote, BASE_REF, commitAll, pushed } from "./git.ts";
import { prepareWorkspace } from "./workspace.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewbit-ws-"));
  dirs.push(dir);
  return dir;
}

/** A real repository to clone from, so the test exercises git rather than a mock. */
/**
 * A repository every test gets its own copy of.
 *
 * Building one costs five git processes, which is 700ms on a Mac where the
 * shell's git is ad-hoc signed and revalidated on every exec. A directory copy
 * is 4ms, and the isolation is the same: each test still owns a repository
 * nothing else writes to.
 *
 * Built on first use and kept for the process, because `dirs` is emptied after
 * every test.
 */
let template: string | undefined;

async function templateRepo(): Promise<string> {
  if (template) return template;
  const dir = mkdtempSync(join(tmpdir(), "crewbit-template-"));
  writeFileSync(join(dir, "README.md"), "# a repository\n");
  writeFileSync(join(dir, "app.ts"), "export const answer = 42;\n");
  await seed(dir);
  template = dir;
  return dir;
}

async function seed(dir: string): Promise<void> {
  await run("git", ["init", "-q", "-b", "main"], dir);
  await run("git", ["config", "user.email", "test@example.test"], dir);
  await run("git", ["config", "user.name", "test"], dir);
  // receive-pack answers a push and only then runs `gc --auto`, detached, with
  // the pusher not waiting on it. A test that removes this directory right
  // after pushing to it can catch that orphaned gc mid-write and find the
  // repository whole again, which `git.test.ts`'s template records having
  // reproduced on a loaded CI. Every copy of the template inherits the setting.
  await run("git", ["config", "gc.auto", "0"], dir);
  await run("git", ["add", "."], dir);
  await run("git", ["commit", "-qm", "first"], dir);
}

async function originRepo(extra: Record<string, string> = {}): Promise<{
  url: string;
  branch: string;
}> {
  const dir = scratch();

  if (Object.keys(extra).length === 0) {
    rmSync(dir, { recursive: true, force: true });
    cpSync(await templateRepo(), dir, { recursive: true });
    return { url: dir, branch: "main" };
  }

  writeFileSync(join(dir, "README.md"), "# a repository\n");
  writeFileSync(join(dir, "app.ts"), "export const answer = 42;\n");
  // A repository that already tracks a file is the only way to ask what an
  // ignore rule does to one, so this one is built rather than copied.
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  await seed(dir);

  return { url: dir, branch: "main" };
}

/** Who the runner commits as, which is one of the identities these branches carry. */
const RUNNER = "crewbit@users.noreply.github.com";

/**
 * A commit made the way the runner makes one.
 *
 * The decision to continue a branch no longer reads the committer, but a fixture
 * standing for a round of the runner's own work still has to be one: `seed`'s
 * `test@example.test` is a person, and the cases here turn on having both
 * identities on the same branch.
 */
async function commitAsRunner(dir: string, message: string): Promise<void> {
  await run("git", ["add", "."], dir);
  await run(
    "git",
    ["-c", `user.email=${RUNNER}`, "-c", "user.name=crewbit", "commit", "-qm", message],
    dir,
  );
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

describe("a Job with no repository", () => {
  test("gets a workspace with just its context", async () => {
    const workspace = await prepareWorkspace({ context: { "spec.md": "## Problem" } });
    dirs.push(workspace);

    expect(await readdir(workspace)).toEqual(["spec.md"]);
  });
});

describe("a Job carrying a repository", () => {
  test("gets a checkout it can read", async () => {
    const origin = await originRepo();

    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem" },
      repo: {
        url: origin.url,
        baseBranch: origin.branch,
        branch: "crewbit/x",
        token: "",
        tokenExpiresAt: "",
      },
    });
    dirs.push(workspace);

    // Without this the plan stage is told to explore a codebase and handed an
    // empty directory.
    expect(await readFile(join(workspace, "app.ts"), "utf8")).toContain("answer = 42");
  });

  test("and its context alongside, so both are readable by relative path", async () => {
    const origin = await originRepo();

    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem\nreadable" },
      repo: {
        url: origin.url,
        baseBranch: origin.branch,
        branch: "b",
        token: "",
        tokenExpiresAt: "",
      },
    });
    dirs.push(workspace);

    expect(await readFile(join(workspace, "spec.md"), "utf8")).toContain("readable");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toContain("a repository");
  });

  test("shallow, because a plan needs the tree and not the history", async () => {
    const origin = await originRepo();

    const workspace = await prepareWorkspace({
      context: {},
      // Over a `file://` url, because git ignores --depth for a plain local path:
      // it hardlinks instead. A real remote is always the network case.
      repo: {
        url: `file://${origin.url}`,
        baseBranch: origin.branch,
        branch: "b",
        token: "",
        tokenExpiresAt: "",
      },
    });
    dirs.push(workspace);

    const depth = await readFile(join(workspace, ".git", "shallow"), "utf8").catch(() => "");
    expect(depth.trim().length).toBeGreaterThan(0);
  });

  test("a context file cannot overwrite a repository file", async () => {
    const origin = await originRepo();

    const workspace = await prepareWorkspace({
      context: { "app.ts": "malicious" },
      repo: {
        url: origin.url,
        baseBranch: origin.branch,
        branch: "b",
        token: "",
        tokenExpiresAt: "",
      },
    });
    dirs.push(workspace);

    // The server chooses the context filenames, but a Stage reading its own spec
    // must not be able to see a replaced source file as if it were the real one.
    expect(await readFile(join(workspace, "app.ts"), "utf8")).toContain("answer = 42");
  });

  test("a clone that fails says so, rather than handing over an empty directory", async () => {
    await expect(
      prepareWorkspace({
        context: {},
        repo: {
          url: join(tmpdir(), "definitely-not-a-repo"),
          baseBranch: "main",
          branch: "b",
          token: "",
          tokenExpiresAt: "",
        },
      }),
    ).rejects.toThrow(/clone/i);
  });
});

/** What git reports, so a test asserts on git rather than on our own bookkeeping. */
async function gitOut(args: string[], cwd: string): Promise<string> {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  for await (const chunk of child.stdout) out += chunk;
  await new Promise((resolve) => child.on("close", resolve));
  return out.trim();
}

const grant = (origin: { url: string; branch: string }, branch = "crewbit/spec-1") => ({
  url: origin.url,
  baseBranch: origin.branch,
  branch,
  token: "",
  tokenExpiresAt: "",
});

describe("a workspace the code stage can write in", () => {
  test("is already on the branch the server named", async () => {
    const origin = await originRepo();

    const workspace = await prepareWorkspace({ context: {}, repo: grant(origin) });
    dirs.push(workspace);

    // The runner never chooses this. A runner that picked its own branch name
    // could push over the base branch by picking its name.
    expect(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], workspace)).toBe("crewbit/spec-1");
  });

  test("branches from the base, so the work starts where the base branch is", async () => {
    const origin = await originRepo();
    const base = await gitOut(["rev-parse", "HEAD"], origin.url);

    const workspace = await prepareWorkspace({ context: {}, repo: grant(origin) });
    dirs.push(workspace);

    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(base);
  });

  test("commits without borrowing an identity from the machine", async () => {
    const origin = await originRepo();
    const workspace = await prepareWorkspace({ context: {}, repo: grant(origin) });
    dirs.push(workspace);
    // A tracked file, so `commit -a` has something to stage.
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");

    // Global and system config disabled: whatever identity this commit uses has
    // to be the one on the clone. Otherwise a commit is attributed to whoever
    // owns the machine, which on a shared runner is the wrong person entirely.
    const code = await runWithoutAmbientGit(["commit", "-qam", "work"], workspace);

    expect(code).toBe(0);
    expect(await gitOut(["log", "-1", "--format=%an <%ae>"], workspace)).toContain("crewbit");
  });

  test("leaves a Job with no repository alone, having no branch to create", async () => {
    const workspace = await prepareWorkspace({ context: { "spec.md": "x" } });
    dirs.push(workspace);

    expect(await readdir(workspace)).toEqual(["spec.md"]);
  });
});

/**
 * What `git add -A && git commit` actually recorded.
 *
 * The question every test below asks is "what would the pull request carry",
 * and that is a commit, not the contents of an exclude file.
 */
async function committedFiles(workspace: string): Promise<string[]> {
  await run("git", ["add", "-A"], workspace);
  await run("git", ["commit", "-qm", "work"], workspace);
  const listed = await gitOut(["ls-tree", "-r", "--name-only", "HEAD"], workspace);
  return listed.split("\n").filter(Boolean);
}

describe("the Job's own paperwork stays out of the repository", () => {
  test("a context file is not committed alongside the agent's work", async () => {
    const origin = await originRepo();
    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem" },
      repo: grant(origin),
    });
    dirs.push(workspace);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");

    const committed = await committedFiles(workspace);

    expect(committed).toContain("app.ts");
    expect(committed).not.toContain("spec.md");
  });

  test("and neither is a file deeper in the tree, so the pattern is not left loose", async () => {
    const origin = await originRepo();
    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem" },
      repo: grant(origin),
    });
    dirs.push(workspace);
    // A file the repository does not track, sharing a context filename. It is a
    // real change and belongs in the commit: a bare `spec.md` in an exclude file
    // matches at every depth and would silently drop it.
    mkdirSync(join(workspace, "docs"));
    writeFileSync(join(workspace, "docs", "spec.md"), "# the product spec\n");

    expect(await committedFiles(workspace)).toContain("docs/spec.md");
  });

  test("a file the Job will collect is not committed alongside the agent's work", async () => {
    const origin = await originRepo();
    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      artifacts: ["pr-body.md"],
    });
    dirs.push(workspace);
    writeFileSync(join(workspace, "app.ts"), "export const answer = 43;\n");
    writeFileSync(join(workspace, "pr-body.md"), "## What changed\nthe answer\n");

    const committed = await committedFiles(workspace);

    // The description of the change is not part of the change.
    expect(committed).toContain("app.ts");
    expect(committed).not.toContain("pr-body.md");
  });

  test("but the agent can still read it back, because an ignore rule is not a permission", async () => {
    const origin = await originRepo();
    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      artifacts: ["pr-body.md"],
    });
    dirs.push(workspace);
    writeFileSync(join(workspace, "pr-body.md"), "## What changed\nthe answer\n");

    await committedFiles(workspace);

    // Excluding it must leave it on disk: this is the file the server collects,
    // and the agent revises it by relative path while it works.
    expect(await readFile(join(workspace, "pr-body.md"), "utf8")).toContain("the answer");
  });

  test("a tracked file whose name collides with an artifact still carries its change", async () => {
    const origin = await originRepo({ "notes.md": "the old notes\n" });
    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      artifacts: ["notes.md"],
    });
    dirs.push(workspace);
    writeFileSync(join(workspace, "notes.md"), "the new notes\n");

    await committedFiles(workspace);

    // An ignore rule does not apply to a file git already tracks, which is what
    // keeps excluding by name from silently dropping a real change.
    expect(await gitOut(["show", "HEAD:notes.md"], workspace)).toContain("the new notes");
  });

  test("an artifact name deeper in the tree is a real change and is committed", async () => {
    const origin = await originRepo();
    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      artifacts: ["plan.md"],
    });
    dirs.push(workspace);
    mkdirSync(join(workspace, "docs"));
    writeFileSync(join(workspace, "docs", "plan.md"), "# the roadmap\n");
    writeFileSync(join(workspace, "plan.md"), "## Plan\nthe Job's own\n");

    const committed = await committedFiles(workspace);

    expect(committed).toContain("docs/plan.md");
    expect(committed).not.toContain("plan.md");
  });

  test("a Job with no repository is unaffected by the names it will collect", async () => {
    const workspace = await prepareWorkspace({
      context: { "spec.md": "## Problem" },
      artifacts: ["pr-body.md"],
    });
    dirs.push(workspace);

    // There is no clone, so there is no exclude file to write to. Reaching for
    // one anyway is how this would throw on the stage that has no repository.
    expect(await readdir(workspace)).toEqual(["spec.md"]);
  });
});

/** git with no global or system config, which is how the property above is proven. */
function runWithoutAmbientGit(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** A branch cut from an older base, with the base then gaining commits. */
async function diverged(): Promise<{ url: string; branch: string }> {
  const origin = await originRepo();
  await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
  writeFileSync(join(origin.url, "mine.ts"), "export const mine = 1;\n");
  await commitAsRunner(origin.url, "the change");

  await run("git", ["checkout", "-q", "main"], origin.url);
  for (const n of [1, 2, 3]) {
    writeFileSync(join(origin.url, `later${n}.ts`), `export const later = ${n};\n`);
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", `later ${n}`], origin.url);
  }
  return origin;
}

describe("a base branch that moved after the work branch was cut", () => {
  test("the diff is the branch's own change, and not the base's newer work reversed", async () => {
    const origin = await diverged();

    const workspace = await prepareWorkspace({
      context: {},
      delivers: true,
      repo: {
        url: origin.url,
        baseBranch: "main",
        branch: "crewbit/spec-1",
        token: "",
        tokenExpiresAt: "",
      },
    });

    const diff = await readFile(join(workspace, "diff.md"), "utf8");
    // Two-dot against the base's tip showed everything main gained as a
    // deletion, and the eval's fraud scan failed the change for deleting tests
    // it had never touched.
    expect(diff).toContain("mine.ts");
    expect(diff).not.toContain("later1.ts");
    expect(diff).not.toContain("later2.ts");
    expect(diff).not.toContain("later3.ts");
  });

  test("and the commits it reports are its own, so the diff and the body agree", async () => {
    const origin = await diverged();

    const workspace = await prepareWorkspace({
      context: {},
      delivers: true,
      repo: {
        url: origin.url,
        baseBranch: "main",
        branch: "crewbit/spec-1",
        token: "",
        tokenExpiresAt: "",
      },
    });

    const { commitsSince } = await import("./git.ts");
    expect(await commitsSince(workspace)).toHaveLength(1);
  });

  test("and the branch's own work is in the tree, which is what continuing it is for", async () => {
    const origin = await diverged();

    const workspace = await prepareWorkspace({
      context: {},
      delivers: true,
      repo: {
        url: origin.url,
        baseBranch: "main",
        branch: "crewbit/spec-1",
        token: "",
        tokenExpiresAt: "",
      },
    });
    dirs.push(workspace);

    // A branch carrying commits is continued as it always was: a fix round picks
    // up where the last one stopped rather than writing it again.
    expect(await readdir(workspace)).toContain("mine.ts");
  });

  test("a first round, where the branch does not exist yet, is unchanged", async () => {
    const origin = await originRepo();

    const workspace = await prepareWorkspace({
      context: {},
      delivers: true,
      repo: {
        url: origin.url,
        baseBranch: "main",
        branch: "crewbit/spec-9",
        token: "",
        tokenExpiresAt: "",
      },
    });

    // Nothing has diverged, so there is nothing to diff and no file for it.
    const { commitsSince } = await import("./git.ts");
    expect(await commitsSince(workspace)).toEqual([]);
  });
});

describe("a stage that reads the work without delivering any", () => {
  test("still gets the branch, because judging the base against the base judges nothing", async () => {
    const origin = await originRepo();
    await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
    writeFileSync(join(origin.url, "mine.ts"), "export const mine = 1;\n");
    await commitAsRunner(origin.url, "the change");
    await run("git", ["checkout", "-q", "main"], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      // What the eval stage is: it reads the change and pushes nothing.
      delivers: false,
      continues: true,
      repo: {
        url: origin.url,
        baseBranch: "main",
        branch: "crewbit/spec-1",
        token: "",
        tokenExpiresAt: "",
      },
    });

    // Every eval that ever ran checked out a fresh branch at the base's tip and
    // reported "no change submitted" about work that was sitting on the remote.
    const diff = await readFile(join(workspace, "diff.md"), "utf8");
    expect(diff).toContain("mine.ts");
  });

  test("a stage that reads only the base still does not, so a re-plan is not pinned", async () => {
    const origin = await originRepo();
    await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
    writeFileSync(join(origin.url, "stale.ts"), "export const stale = 1;\n");
    await commitAsRunner(origin.url, "an earlier round");
    await run("git", ["checkout", "-q", "main"], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      delivers: false,
      continues: false,
      repo: {
        url: origin.url,
        baseBranch: "main",
        branch: "crewbit/spec-1",
        token: "",
        tokenExpiresAt: "",
      },
    });

    // The plan stage explores the base as it is now. Checking out the work
    // branch pinned two re-planned Specs to a two-hour-old snapshot.
    const files = await readdir(workspace);
    expect(files).not.toContain("stale.ts");
  });
});

describe("a branch that carries no commits of its own", () => {
  /**
   * The branch a first round pushed before the engine wrote anything, with the
   * base moving on afterwards. It exists on the remote and points at an old base
   * commit, so continuing it buys the fetch's guarantee and pays a tree as old as
   * the branch.
   */
  async function pointerOnly(): Promise<{ url: string; branch: string; at: string }> {
    const origin = await originRepo();
    // A commit on the base before the branch is cut, so the branch's tip has
    // history behind it. Cut from the root commit there is nothing to deepen,
    // and a clone that paid the deepen would be indistinguishable from one that
    // never did.
    writeFileSync(join(origin.url, "before.ts"), "export const before = 1;\n");
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "before the branch"], origin.url);

    const at = await gitOut(["rev-parse", "HEAD"], origin.url);
    await run("git", ["branch", "crewbit/spec-1"], origin.url);

    for (const n of [1, 2]) {
      writeFileSync(join(origin.url, `later${n}.ts`), `export const later = ${n};\n`);
      await run("git", ["add", "."], origin.url);
      await run("git", ["commit", "-qm", `later ${n}`], origin.url);
    }
    return { ...origin, at };
  }

  test("is not continued: the Stage starts from the freshly cloned base", async () => {
    const origin = await pointerOnly();
    const base = await gitOut(["rev-parse", "HEAD"], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      repo: grant(origin),
    });
    dirs.push(workspace);

    // Continuing this branch checks out whatever the base was on the day it was
    // created, and the Stage then works from that tree every time it is
    // dispatched.
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(base);
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).not.toBe(origin.at);
    expect(await readdir(workspace)).toContain("later2.ts");
  });

  test("under the branch name the server gave, so it still has somewhere to push", async () => {
    const origin = await pointerOnly();

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      repo: grant(origin),
    });
    dirs.push(workspace);

    // Starting fresh is not starting on the base branch: the Stage still commits
    // and pushes under the name the server chose.
    expect(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], workspace)).toBe("crewbit/spec-1");
  });

  test("even out of a genuinely shallow clone, which is what the deepen is for", async () => {
    const origin = await pointerOnly();
    const base = await gitOut(["rev-parse", "HEAD"], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      // Over a `file://` url, because git ignores --depth for a plain local
      // path: it hardlinks the whole history instead. This is the only case
      // here where the count cannot be read without the deepen first, so it is
      // the test that fails if the deepen is missing or runs after the
      // decision.
      repo: grant({ url: `file://${origin.url}`, branch: origin.branch }),
    });
    dirs.push(workspace);

    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(base);
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).not.toBe(origin.at);
    expect(await readdir(workspace)).toContain("later2.ts");
  });

  test("a branch whose tip is exactly the base commit starts fresh, and holds no lease", async () => {
    const origin = await originRepo();
    const base = await gitOut(["rev-parse", "HEAD"], origin.url);
    await run("git", ["branch", "crewbit/spec-1", base], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      repo: grant(origin),
    });
    dirs.push(workspace);

    // Zero commits ahead of the base is the case #20 was written for, and it
    // still starts fresh: under the name the server gave, and with no lease, so
    // a branch that moved between this fetch and the push is not forced over.
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(base);
    expect(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], workspace)).toBe("crewbit/spec-1");
    expect(
      await gitOut(["rev-parse", "--verify", "--quiet", "refs/crewbit/remote"], workspace),
    ).toBe("");
  });

  test("a branch the remote has never seen is still the first round, unchanged", async () => {
    const origin = await originRepo();
    const base = await gitOut(["rev-parse", "HEAD"], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      repo: grant(origin, "crewbit/spec-9"),
    });
    dirs.push(workspace);

    // The fetch fails, so there is no tip to count commits from and no deepen
    // paid. Reaching for one anyway is how this path would break.
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(base);
    expect(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], workspace)).toBe("crewbit/spec-9");
    const { commitsSince } = await import("./git.ts");
    expect(await commitsSince(workspace)).toEqual([]);
  });
});

describe("a branch that carries commits the base does not, whoever committed them", () => {
  /** A person's commit on top of the runner's rounds, which #291's branch had. */
  async function personOnTop(): Promise<{ url: string; branch: string; tip: string }> {
    const origin = await originRepo();
    await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
    writeFileSync(join(origin.url, "mine.ts"), "export const mine = 1;\n");
    await commitAsRunner(origin.url, "the runner's work");
    writeFileSync(join(origin.url, "theirs.ts"), "export const theirs = 1;\n");
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "a person, on top"], origin.url);
    const tip = await gitOut(["rev-parse", "HEAD"], origin.url);
    await run("git", ["checkout", "-q", "main"], origin.url);
    return { ...origin, tip };
  }

  test("a person's commit on top of the runner's is continued, not started over", async () => {
    const origin = await personOnTop();

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      repo: grant(origin),
    });
    dirs.push(workspace);

    // A `chore:` commit the coordinator pushed on top of three rounds of the
    // runner's own work made the next round start fresh from the base, and its
    // push was then refused as a non-fast-forward: the round ended in
    // `error.txt` with no turn spent, and the branch's real work sat one commit
    // below.
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(origin.tip);
    const files = await readdir(workspace);
    expect(files).toContain("mine.ts");
    expect(files).toContain("theirs.ts");
  });

  test("and so is a branch whose only commit is a person's", async () => {
    const origin = await originRepo();
    await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
    writeFileSync(join(origin.url, "theirs.ts"), "export const theirs = 1;\n");
    await run("git", ["add", "."], origin.url);
    await run(
      "git",
      ["commit", "-qm", "a reviewer's fix, on a branch with nothing else"],
      origin.url,
    );
    const tip = await gitOut(["rev-parse", "HEAD"], origin.url);
    await run("git", ["checkout", "-q", "main"], origin.url);

    const workspace = await prepareWorkspace({
      context: {},
      continues: true,
      repo: grant(origin),
    });
    dirs.push(workspace);

    // No commit of the runner's anywhere on it, so the committer of the tip is
    // no help at all. A branch carries work when it has commits the base does
    // not, whoever made them.
    expect(await gitOut(["rev-parse", "HEAD"], workspace)).toBe(tip);
    expect(await readdir(workspace)).toContain("theirs.ts");
  });
});

function reading(): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return { log: createLogger("test", (line) => lines.push(JSON.parse(line))), lines };
}

/** A repository that ships everything `.claude/` can hold, hostile and legitimate alike. */
async function hostileOriginRepo(): Promise<{ url: string; branch: string }> {
  const dir = scratch();

  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  mkdirSync(join(dir, ".claude", "skills", "s"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# a repository\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# project instructions\n");
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { evil: { command: "sh" } } }),
  );
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "id" }] }] } }),
  );
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ hooks: {} }));
  writeFileSync(join(dir, ".claude", "agents", "reviewer.md"), "# a custom agent\n");
  writeFileSync(join(dir, ".claude", "skills", "s", "SKILL.md"), "# a custom skill\n");
  writeFileSync(join(dir, ".claude", "rules", "ready_for_code.md"), "# ready for code\n");
  writeFileSync(join(dir, ".claude", "rules", "planning.md"), "# planning\n");
  writeFileSync(join(dir, ".claude", "rules", "testing.md"), "# testing\n");

  // `git add .` alone, not the same as `seed`'s: this machine's own global
  // gitignore excludes `.claude/settings.local.json`, which a repository
  // actually trying to carry one would simply force in.
  await run("git", ["init", "-q", "-b", "main"], dir);
  await run("git", ["config", "user.email", "test@example.test"], dir);
  await run("git", ["config", "user.name", "test"], dir);
  await run("git", ["add", "-f", "."], dir);
  await run("git", ["commit", "-qm", "first"], dir);

  return { url: dir, branch: "main" };
}

describe("what a checked-out repository may configure the engine with", () => {
  test("keeps the rules and CLAUDE.md, and removes everything else .claude/ or .mcp.json can hold", async () => {
    const origin = await hostileOriginRepo();
    const { log, lines } = reading();

    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      log,
      jobId: "job_1",
    });
    dirs.push(workspace);

    expect(await readdir(join(workspace, ".claude"))).toEqual(["rules"]);
    expect(await readdir(join(workspace, ".claude", "rules")).then((f) => f.sort())).toEqual([
      "planning.md",
      "ready_for_code.md",
      "testing.md",
    ]);
    expect(await readFile(join(workspace, "CLAUDE.md"), "utf8")).toContain("project instructions");
    expect(await readdir(workspace)).not.toContain(".mcp.json");

    // What the engine would otherwise have started is on record, against the
    // Job that carried it.
    const warned = lines.find(
      (line) => line.message === "removed engine configuration the checkout carried",
    );
    expect(warned).toBeTruthy();
    expect(warned).toMatchObject({ job_id: "job_1" });
    const removed = (warned as { removed: string[] }).removed;
    // Directory granularity, one entry per thing removed rather than one per
    // file: `.claude/skills` says more to a person than forty file names.
    expect(removed.slice().sort()).toEqual([
      ".claude/agents",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/skills",
      ".mcp.json",
    ]);
  });

  test("removing it is not a change to git, so the workspace starts clean", async () => {
    const origin = await hostileOriginRepo();

    const workspace = await prepareWorkspace({ context: {}, repo: grant(origin) });
    dirs.push(workspace);

    // The files stay tracked, so removing them from the worktree alone shows
    // every one of them as deleted, and the code stage's `git add -A` commits
    // the deletions: a pull request that deletes the repository's own agents,
    // skills and settings.
    expect(await gitOut(["status", "--porcelain"], workspace)).toBe("");
    const present = await readdir(join(workspace, ".claude"));
    expect(present).not.toContain("settings.json");
    expect(present).not.toContain("agents");
    expect(present).not.toContain("skills");
    expect(await readdir(workspace)).not.toContain(".mcp.json");
  });

  test("so a commit of everything carries only what the engine wrote", async () => {
    const origin = await hostileOriginRepo();
    const workspace = await prepareWorkspace({ context: {}, repo: grant(origin) });
    dirs.push(workspace);

    // The fake engine: one file written, which is the whole of its change.
    writeFileSync(join(workspace, "new.ts"), "export const added = 1;\n");
    const { changedFiles, commitAll } = await import("./git.ts");
    expect(await commitAll(workspace, "work")).toBe(true);

    // What the server's checks read. Measured on crewbit-v2#291: a diff of 48
    // files for a change of 4, the other 44 being this removal.
    expect(await changedFiles(workspace)).toBe("new.ts");
  });

  test("and the rules and CLAUDE.md are still on disk, untouched", async () => {
    const origin = await hostileOriginRepo();

    const workspace = await prepareWorkspace({ context: {}, repo: grant(origin) });
    dirs.push(workspace);

    expect(await readdir(join(workspace, ".claude", "rules")).then((f) => f.sort())).toEqual([
      "planning.md",
      "ready_for_code.md",
      "testing.md",
    ]);
    const rules = join(workspace, ".claude", "rules");
    expect(await readFile(join(rules, "planning.md"), "utf8")).toBe("# planning\n");
    expect(await readFile(join(rules, "ready_for_code.md"), "utf8")).toBe("# ready for code\n");
    expect(await readFile(join(rules, "testing.md"), "utf8")).toBe("# testing\n");
    expect(await readFile(join(workspace, "CLAUDE.md"), "utf8")).toBe("# project instructions\n");
  });

  test("a repository carrying none of it is unchanged, and logs nothing", async () => {
    const origin = await originRepo();
    const { log, lines } = reading();

    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      log,
      jobId: "job_2",
    });
    dirs.push(workspace);

    expect(await readFile(join(workspace, "app.ts"), "utf8")).toContain("answer = 42");
    expect(lines).toEqual([]);
  });

  test("and carries no skip-worktree entries, because there was nothing to strip", async () => {
    const origin = await originRepo();
    const { log, lines } = reading();

    const workspace = await prepareWorkspace({
      context: {},
      repo: grant(origin),
      log,
      jobId: "job_3",
    });
    dirs.push(workspace);

    // `git ls-files -v` prefixes a skip-worktree entry with `S`. The ordinary
    // Job clones a repository with none of this, and its index must read
    // exactly as it did before.
    const listed = await gitOut(["ls-files", "-v"], workspace);
    expect(listed.split("\n").filter((line) => line.startsWith("S"))).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("pushing a branch the runner already owns", () => {
  const deliver = (origin: { url: string; branch: string }, branch = "crewbit/spec-1") =>
    prepareWorkspace({ context: {}, delivers: true, repo: grant(origin, branch) });

  /**
   * What crewbit-sh/cli#4 will do inside the runner, done here by hand: the
   * branch's own commits replayed onto the base's current tip. The result is no
   * longer a fast-forward of what the remote holds, which is the whole of why a
   * fix round asked to rebase could not deliver.
   */
  async function rebaseOntoBase(workspace: string, origin: { url: string }): Promise<void> {
    const fork = await gitOut(["rev-parse", BASE_REF], workspace);
    expect(await run("git", ["fetch", "-q", origin.url, "main"], workspace)).toBe(0);
    expect(await run("git", ["rebase", "-q", "--onto", "FETCH_HEAD", fork], workspace)).toBe(0);
  }

  /** A second runner, handed the same Job, that pushes while this one works. */
  async function secondRunnerPushes(origin: { url: string }): Promise<string> {
    const clone = scratch();
    expect(await run("git", ["clone", "-q", origin.url, "."], clone)).toBe(0);
    expect(await run("git", ["checkout", "-q", "crewbit/spec-1"], clone)).toBe(0);
    writeFileSync(join(clone, "theirs.ts"), "export const theirs = 1;\n");
    await commitAsRunner(clone, "another runner, on the same branch");
    expect(
      await run("git", ["push", "-q", "origin", "HEAD:refs/heads/crewbit/spec-1"], clone),
    ).toBe(0);
    return await gitOut(["rev-parse", "HEAD"], clone);
  }

  const originTip = (origin: { url: string }, branch = "crewbit/spec-1") =>
    gitOut(["rev-parse", `refs/heads/${branch}`], origin.url);

  test("a rebase onto a moved base lands, and the remote ends at the local tip", async () => {
    const origin = await diverged();
    const workspace = await deliver(origin);
    dirs.push(workspace);
    await rebaseOntoBase(workspace, origin);

    const { ok } = await pushed(workspace, grant(origin));

    // A fix round asked to rebase did exactly this, ran the suite, and stopped
    // with `blocked.md`: the plain push is a non-fast-forward of what the remote
    // holds, so the round's work never left the runner.
    expect(ok).toBe(true);
    expect(await originTip(origin)).toBe(await gitOut(["rev-parse", "HEAD"], workspace));
  });

  test("another runner's push between this Job's fetch and its own is refused", async () => {
    const origin = await diverged();
    const workspace = await deliver(origin);
    dirs.push(workspace);
    await rebaseOntoBase(workspace, origin);
    const theirs = await secondRunnerPushes(origin);

    const { ok } = await pushed(workspace, grant(origin));

    // The guarantee the fetch exists for: the lease is the tip this Job started
    // from, so a branch that moved since is not history this Job may replace.
    expect(ok).toBe(false);
    expect(await originTip(origin)).toBe(theirs);
    // And this is what makes `deliver` write today's `blocked.md` rather than
    // report work that is not on the remote as delivered.
    expect(await alreadyOnRemote(workspace, grant(origin))).toBe(false);
  });

  test("a first round pushes as today, creating the branch the remote did not have", async () => {
    const origin = await originRepo();
    const workspace = await deliver(origin, "crewbit/spec-9");
    dirs.push(workspace);

    expect((await pushed(workspace, grant(origin, "crewbit/spec-9"))).ok).toBe(true);
    expect(await originTip(origin, "crewbit/spec-9")).toBe(
      await gitOut(["rev-parse", "HEAD"], workspace),
    );
  });

  test("and holds no lease, so a branch that appeared meanwhile is not forced over", async () => {
    const origin = await originRepo();
    const workspace = await deliver(origin, "crewbit/spec-9");
    dirs.push(workspace);
    // Somebody creates the branch this Job was told to push, at a commit this
    // Job has never seen. A lease stamped for a first round would force over it.
    writeFileSync(join(origin.url, "unrelated.ts"), "export const unrelated = 1;\n");
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "somebody else, on a branch we never fetched"], origin.url);
    const theirs = await gitOut(["rev-parse", "HEAD"], origin.url);
    await run("git", ["branch", "crewbit/spec-9", theirs], origin.url);

    expect((await pushed(workspace, grant(origin, "crewbit/spec-9"))).ok).toBe(false);
    expect(await originTip(origin, "crewbit/spec-9")).toBe(theirs);
  });

  test("a branch somebody committed on top of is built on, and their commit kept", async () => {
    const origin = await originRepo();
    await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
    writeFileSync(join(origin.url, "mine.ts"), "export const mine = 1;\n");
    await commitAsRunner(origin.url, "the runner's work");
    writeFileSync(join(origin.url, "theirs.ts"), "export const theirs = 1;\n");
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "a person, on top"], origin.url);
    const theirs = await gitOut(["rev-parse", "HEAD"], origin.url);
    await run("git", ["checkout", "-q", "main"], origin.url);

    const workspace = await deliver(origin);
    dirs.push(workspace);
    writeFileSync(join(workspace, "round.ts"), "export const round = 2;\n");
    expect(await commitAll(workspace, "the round after theirs")).toBe(true);

    // The whole flow, end to end: the round starts from their commit, so its own
    // push is a fast-forward the lease permits rather than the non-fast-forward
    // that used to end the round in `error.txt` with no turn spent.
    expect((await pushed(workspace, grant(origin))).ok).toBe(true);
    expect(await originTip(origin)).toBe(await gitOut(["rev-parse", "HEAD"], workspace));
    // Preserved and built on, never overwritten. The lease is on their commit,
    // which is what makes forcing over it impossible rather than unlikely.
    expect(
      await run("git", ["merge-base", "--is-ancestor", theirs, "crewbit/spec-1"], origin.url),
    ).toBe(0);
    expect(await gitOut(["show", "crewbit/spec-1:theirs.ts"], origin.url)).toContain("theirs = 1");
  });
});
