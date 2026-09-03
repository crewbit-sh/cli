// Temporary diagnostic for the CI-only failure of
// "a refused push that landed anyway > says no when the remote cannot be read at all"
// (src/runner/git.test.ts:191). Mirrors that test's exact setup, using the real
// git.ts/workspace.ts code, with every step logged. Deleted once the cause is known.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alreadyOnRemote, head, pushed, remoteHead } from "../src/runner/git.ts";
import { prepareWorkspace } from "../src/runner/workspace.ts";

console.log("git --version:");
spawnSync("git", ["--version"], { stdio: "inherit" });
console.log("uname -a:");
spawnSync("uname", ["-a"], { stdio: "inherit" });
console.log("TMPDIR env:", process.env.TMPDIR);
console.log("os.tmpdir():", tmpdir());

const sh = (args: string[], cwd: string) => spawnSync("git", args, { cwd, stdio: "ignore" });

function mktempPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

// Build the same prebuilt bare template git.test.ts uses.
const seed = mkdtempSync(join(tmpdir(), "dbg-template-seed-"));
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
const template = mkdtempSync(join(tmpdir(), "dbg-template-"));
spawnSync("git", ["clone", "--bare", "-q", seed, template], { stdio: "ignore" });
spawnSync("git", ["--git-dir", template, "remote", "remove", "origin"], { stdio: "ignore" });
rmSync(seed, { recursive: true, force: true });

// bareOrigin(): a fresh copy of the template, same as the test.
const bare = mktempPath("dbg-origin-");
cpSync(template, bare, { recursive: true });
console.log("\nbare origin at:", bare, "exists:", existsSync(bare));

const repo = { url: bare, baseBranch: "main", branch: "crewbit/spec-1", token: "", tokenExpiresAt: "" };
const workspace = await prepareWorkspace({ context: {}, repo, delivers: true });
console.log("workspace at:", workspace);

const pushResult = await pushed(workspace, repo);
console.log("pushed():", pushResult);

console.log("\n--- removing the bare origin ---");
rmSync(bare, { recursive: true, force: true });
console.log("existsSync(bare) after rmSync:", existsSync(bare));

const localHead = await head(workspace);
console.log("\nlocal head:", localHead);

const remote = await remoteHead(workspace, repo);
console.log("remoteHead() returned:", JSON.stringify(remote));

// Raw ls-remote, exactly as remoteHead builds it, to see the raw process result.
const raw = spawnSync("git", ["ls-remote", bare, `refs/heads/${repo.branch}`], {
  cwd: workspace,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});
console.log("raw ls-remote exit code:", raw.status);
console.log("raw ls-remote stdout:", JSON.stringify(raw.stdout?.toString()));
console.log("raw ls-remote stderr:", JSON.stringify(raw.stderr?.toString()));

const already = await alreadyOnRemote(workspace, repo);
console.log("\nalreadyOnRemote() returned:", already, "(expected false)");

rmSync(workspace, { recursive: true, force: true });
rmSync(template, { recursive: true, force: true });
rmSync(bare, { recursive: true, force: true });

process.exit(already === false ? 0 : 1);
