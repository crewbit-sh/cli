import { describe, expect, test } from "bun:test";
import { rebaseCompletion } from "./rebase.ts";

describe("a rebase Job with no repository grant", () => {
  test("fails, naming why, rather than attempting nothing silently", () => {
    const completion = rebaseCompletion("job-1", { kind: "no_repo" });

    expect(completion.outcome).toBe("failed");
    expect(completion.artifacts["error.txt"]).toContain("repository grant");
  });
});

describe("a rebase that conflicted", () => {
  test("fails with git's own words and the paths the branch touched", () => {
    const completion = rebaseCompletion("job-1", {
      kind: "conflict",
      conflict: "CONFLICT (content): Merge conflict in app.ts",
      changedFiles: "app.ts\n",
    });

    expect(completion.outcome).toBe("failed");
    expect(completion.artifacts["conflict.txt"]).toContain("app.ts");
    expect(completion.artifacts["changed-files.txt"]).toBe("app.ts\n");
  });

  test("records zero turns and zero cost, because no engine ran", () => {
    const completion = rebaseCompletion("job-1", {
      kind: "conflict",
      conflict: "conflict",
      changedFiles: "",
    });

    expect(completion.session).toEqual({ id: "", turns: 0, costUsd: 0, durationMs: 0 });
  });
});

describe("a rebase that applied and was pushed", () => {
  test("completes with the commits the branch carries, and zero cost", () => {
    const completion = rebaseCompletion("job-1", {
      kind: "delivered",
      commits: ["abc123", "def456"],
      artifacts: { "changed-files.txt": "app.ts\n" },
    });

    expect(completion.outcome).toBe("complete");
    expect(completion.commits).toEqual(["abc123", "def456"]);
    expect(completion.artifacts).toEqual({ "changed-files.txt": "app.ts\n" });
    expect(completion.session).toEqual({ id: "", turns: 0, costUsd: 0, durationMs: 0 });
  });

  test("a push that did not land fails the Job, the same guard as any other delivery", () => {
    const completion = rebaseCompletion("job-1", {
      kind: "delivered",
      commits: ["abc123"],
      problem: "failed",
      artifacts: { "blocked.md": "the push did not land" },
    });

    expect(completion.outcome).toBe("failed");
    expect(completion.artifacts["blocked.md"]).toBe("the push did not land");
  });

  test("no commits and no artifacts is still a legal completion", () => {
    const completion = rebaseCompletion("job-1", { kind: "delivered", commits: [] });

    expect(completion.outcome).toBe("complete");
    expect(completion.commits).toEqual([]);
    expect(completion.artifacts).toEqual({});
  });
});
