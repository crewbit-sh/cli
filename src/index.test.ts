import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  Engine,
  EngineEvent,
  EngineResult,
  EngineRun,
  FakeEngine,
  Logger,
  RunnerHandle,
  RunnerOptions,
} from "./index.ts";
import { RUNNER_VERSION } from "./index.ts";

/**
 * `RUNNER_VERSION` is what `--version` prints and what the handshake sends,
 * and it was a literal nobody updated: `package.json` and `CHANGELOG.md`
 * moved on and this stayed behind at a placeholder.
 */
describe("the version the binary reports", () => {
  test("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    expect(RUNNER_VERSION).toBe(pkg.version);
  });

  test("matches the newest release CHANGELOG.md declares", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const newest = changelog.match(/^## (\d+\.\d+\.\d+)$/m)?.[1];

    // A throw and not an assertion: a changelog with no version heading at all
    // is a broken fixture rather than a version that disagrees, and the throw is
    // also what narrows the match away from undefined.
    if (!newest) throw new Error("the changelog declares no version");
    expect(RUNNER_VERSION).toBe(newest);
  });
});

describe("what the package publishes", () => {
  test("every name a consumer imports is still on it", async () => {
    const facade = await import("./index.ts");

    expect(Object.keys(facade).sort()).toEqual([
      "REFUSED_HANDSHAKE",
      "RUNNER_VERSION",
      "buildArgs",
      "buildEnv",
      "claudeCliEngine",
      "consumeStream",
      "createLogger",
      "errorFields",
      "failedResult",
      "fakeEngine",
      "parseLine",
      "startRunner",
    ]);
  });
});

// The eight types have no runtime presence, so their check is this compiling.
type Published = [
  Engine,
  EngineEvent,
  EngineResult,
  EngineRun,
  FakeEngine,
  Logger,
  RunnerHandle,
  RunnerOptions,
];

export type { Published };
