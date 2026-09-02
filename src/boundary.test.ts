/**
 * The runner is the least trusted component in the system: it executes
 * model-authored code on somebody's machine. Two properties keep that bounded,
 * and both were checked by the service's own suite while this
 * package lived there. They moved here with the package, because a guarantee
 * whose only check is in another repository is a guarantee nobody holds.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

const manifest = () =>
  JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

/** Everything the compiled binary is built from: `src`, minus its own tests. */
function shipped(): string[] {
  return readdirSync(new URL("src", root), { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
}

describe("the runner cannot reach a provider", () => {
  test("its manifest declares the protocol and nothing else", () => {
    // Asserted on the manifest rather than on greps, so it stays true as files
    // move: an import of a provider does not resolve, it does not merely fail
    // review.
    expect(Object.keys(manifest().dependencies ?? {})).toEqual(["@crewbit/protocol"]);
  });

  test("no provider is reachable from it", () => {
    // A runner that could resolve a provider type would make the trust boundary
    // a convention again, which is why the Capability interface is its own
    // package rather than part of @crewbit/protocol.
    const declared = Object.keys(manifest().dependencies ?? {});

    expect(declared.filter((name) => name.includes("provider"))).toEqual([]);
  });

  test("and nothing it ships imports a dependency it only has for tests", () => {
    // The half the manifest cannot say here. In the monorepo this package
    // declared no devDependencies at all, so the manifest was the whole check;
    // standing on its own it needs vitest and a WebSocket server for the
    // testkit, and either would resolve from `src` and be bundled into the
    // binary without the manifest changing.
    const dev = Object.keys(manifest().devDependencies ?? {});
    const leaked: string[] = [];

    for (const file of shipped()) {
      const source = readFileSync(new URL(`src/${file}`, root), "utf8");
      for (const [, specifier] of source.matchAll(/^import[^"']*["']([^"']+)["']/gm)) {
        const owner = dev.find((name) => specifier === name || specifier?.startsWith(`${name}/`));
        if (owner) leaked.push(`${file} imports ${owner}`);
      }
    }

    expect(leaked).toEqual([]);
  });
});

describe("the runner stays runtime-portable", () => {
  test("nothing it ships names Bun", () => {
    // Measured while writing the test below: running the CLI catches a Bun API
    // at module scope or on the `--version` path, and misses one inside a
    // function that `--version` never calls, which is where nearly all of this
    // package's code lives. This is that half, and it is a scan because there
    // is no manifest that can express "does not use a global".
    const named: string[] = [];

    for (const file of shipped()) {
      const source = readFileSync(new URL(`src/${file}`, root), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      if (/\bBun\s*\./.test(source)) named.push(`${file} uses the Bun global`);
      if (/from\s*["']bun["']/.test(source)) named.push(`${file} imports bun`);
    }

    expect(named).toEqual([]);
  });

  test("node runs its CLI, which fails the moment a Bun-only API leaks in", async () => {
    // Compiled by Bun and has to run under Node, which reads as a contradiction
    // until you see that the binary is Bun's and the code is nobody's. This is
    // the cheap half of that guarantee; the expensive half dials a real server
    // and lives with the service.
    const cli = new URL("src/cli.ts", root).pathname;

    const { code, stdout, stderr } = await run("node", [cli, "--version"]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

function run(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
