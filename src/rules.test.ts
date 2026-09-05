/**
 * The rules in `.claude/rules/` describe this tree: its layout, its test
 * command, its files. A document that describes a tree goes stale the day the
 * tree moves, and nothing about a markdown file fails when it does.
 *
 * So the rules are held to the tree the way `src/boundary.test.ts` holds the
 * manifest to it — from a test, not from review. The strongest of the
 * assertions below is `planning.md`'s own "every path you name must exist",
 * turned on the rules themselves.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

const RULES = [
  ".claude/rules/planning.md",
  ".claude/rules/ready_for_code.md",
  ".claude/rules/testing.md",
];

/** The command this repository runs its suite with, read off the manifest. */
function testCommand(): string {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    scripts?: Record<string, string>;
  };

  return manifest.scripts?.test ?? "";
}

const read = (path: string): string | null =>
  existsSync(new URL(path, root)) ? readFileSync(new URL(path, root), "utf8") : null;

/** The top-level directories a cited path can be rooted at, read off the tree. */
function roots(): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules",
    )
    .map((entry) => entry.name);
}

/**
 * The repository paths one line cites, and whether the line excuses them from
 * having to exist. A path is only allowed to be absent when its line marks it
 * **new file**, which is the wording `planning.md` requires for exactly this.
 */
function cited(line: string): { path: string; exempt: boolean }[] {
  const exempt = /new file/i.test(line);
  const known = roots();

  return line
    .split(/[\s`"'()[\]<>]+/)
    .map((token) => token.replace(/[.,;:!?]+$/, ""))
    .filter((token) => token.includes("/") && known.includes(token.split("/")[0] ?? ""))
    .map((path) => ({ path, exempt }));
}

/** The part of a cited path that has to resolve: a glob keeps its literal head. */
function resolvable(path: string): string {
  const literal = path.includes("*") ? path.slice(0, path.indexOf("*")) : path;

  return literal.replace(/\/+$/, "");
}

/**
 * Every complaint one rule document raises, as a line naming it. Returns them
 * all rather than throwing on the first, so one run names all the drift.
 */
function auditText(path: string, text: string | null): string[] {
  if (text === null) return [`${path} is missing`];
  if (text.trim() === "") return [`${path} is empty`];

  const complaints: string[] = [];

  for (const line of text.split("\n")) {
    for (const { path: name, exempt } of cited(line)) {
      if (exempt) continue;
      const target = new URL(resolvable(name), root);
      if (!existsSync(target)) complaints.push(`${path} cites ${name}, which is not in the tree`);
    }
  }

  return complaints;
}

const auditRules = () => RULES.flatMap((path) => auditText(path, read(path)));

describe("the three rules are installed", () => {
  test("each of the three is present and has something in it", () => {
    // The three together, so a run names every one that is absent rather than
    // stopping at the first. An empty file is called out here and not by the
    // path scan below, which has nothing to say about a document citing
    // nothing.
    const missing = RULES.filter((path) => read(path) === null);
    const empty = RULES.filter((path) => read(path)?.trim() === "");

    expect({ missing, empty }).toEqual({ missing: [], empty: [] });
  });
});

describe("the testing rule describes this repository", () => {
  test("it names the test command the manifest actually defines", () => {
    // Read off package.json rather than hardcoded, so editing either one alone
    // is what fails: a rule quoting a command nobody can run is worse than a
    // rule that quotes none.
    const text = read(".claude/rules/testing.md") ?? "";
    const command = testCommand();

    expect(command).not.toBe("");
    expect(text).toContain(command);
  });

  test("it was adapted, not installed unchanged", () => {
    // The rule arrives describing a monorepo of `packages/<name>` with a root
    // directory for integration tests. This package has neither, and a rule
    // pointing at a layout that is not here is a rule nobody can follow.
    const text = read(".claude/rules/testing.md");

    expect(text).toBeTypeOf("string");
    expect(text).not.toContain("packages/");
    expect(text).not.toContain("test/");
  });
});

describe("every path the rules name exists", () => {
  test("nothing the three of them cite is missing from the tree", () => {
    expect(auditRules()).toEqual([]);
  });

  test("a path marked new file is allowed not to exist yet", () => {
    // planning.md's own example cites a command that has not been written. It
    // has to survive the scan, or the rule cannot show the wording it requires.
    const text = read(".claude/rules/planning.md") ?? "";
    const example = "src/commands/health.ts";

    expect(text).toContain(example);
    expect(existsSync(new URL(example, root))).toBe(false);
    expect(auditText("planning.md", text)).toEqual([]);
    expect(auditText("x.md", `- ${example} — the handler`)).toEqual([
      `x.md cites ${example}, which is not in the tree`,
    ]);
  });

  test("a run names every unresolvable path, not only the first", () => {
    const drift = "- see `src/gone.ts`\n- and `docs/vanished.md`\n";

    expect(auditText("x.md", drift)).toEqual([
      "x.md cites src/gone.ts, which is not in the tree",
      "x.md cites docs/vanished.md, which is not in the tree",
    ]);
  });

  test("a rule file that is there but empty is a complaint of its own", () => {
    // The empty-input case: a zero-byte file cites no paths, so the scan reads
    // clean on it. Without this it would pass as a rule that is installed.
    expect(auditText("x.md", "")).toEqual(["x.md is empty"]);
    expect(auditText("x.md", null)).toEqual(["x.md is missing"]);
  });

  test("a glob is held to the directory it is rooted at", () => {
    // `src/**` and `testkit/*.integration.test.ts` are how the layout section
    // has to name a set of files, and neither is a path that stats. The head
    // of one still does, which is the part worth checking.
    expect(auditText("x.md", "`src/**` and `testkit/*.integration.test.ts`")).toEqual([]);
    expect(auditText("x.md", "`src/nowhere/**`")).toEqual([
      "x.md cites src/nowhere/**, which is not in the tree",
    ]);
  });
});
