import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
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

    expect(newest, "the changelog declares no version").toBeTruthy();
    expect(RUNNER_VERSION).toBe(newest);
  });
});
