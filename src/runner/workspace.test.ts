import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("a base branch that moved after the work branch was cut", () => {
  /** A branch cut from an older base, with the base then gaining commits. */
  async function diverged(): Promise<{ url: string; branch: string }> {
    const origin = await originRepo();
    await run("git", ["checkout", "-q", "-b", "crewbit/spec-1"], origin.url);
    writeFileSync(join(origin.url, "mine.ts"), "export const mine = 1;\n");
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "the change"], origin.url);

    await run("git", ["checkout", "-q", "main"], origin.url);
    for (const n of [1, 2, 3]) {
      writeFileSync(join(origin.url, `later${n}.ts`), `export const later = ${n};\n`);
      await run("git", ["add", "."], origin.url);
      await run("git", ["commit", "-qm", `later ${n}`], origin.url);
    }
    return origin;
  }

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
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "the change"], origin.url);
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
    await run("git", ["add", "."], origin.url);
    await run("git", ["commit", "-qm", "an earlier round"], origin.url);
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
