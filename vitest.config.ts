import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // git.test.ts and workspace.test.ts shell out to real git subprocesses.
    // vitest's 5s default flakes on those under load; the service's own suite
    // carries the same 60s for the same reason.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
