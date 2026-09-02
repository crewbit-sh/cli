import { describe, expect, test } from "bun:test";
import { outdatedNotice } from "./version.ts";

describe("a runner told which release is newest", () => {
  test("is told to upgrade when it is behind, and by how far", () => {
    const notice = outdatedNotice("0.1.1", "0.1.2");

    expect(notice).toContain("0.1.1");
    expect(notice).toContain("0.1.2");
    // Both versions and where to get the new one: a notice a person cannot act
    // on is one they learn to scroll past.
    expect(notice).toContain("github.com/crewbit-sh/cli/releases");
  });

  test("says nothing on the newest release", () => {
    expect(outdatedNotice("0.1.2", "0.1.2")).toBeUndefined();
  });

  test("says nothing to somebody ahead of the newest release", () => {
    // Running from source between releases is normal, and telling that person
    // to upgrade points them backwards.
    expect(outdatedNotice("0.2.0", "0.1.9")).toBeUndefined();
  });

  test("compares numbers rather than text", () => {
    // `"0.9.0" < "0.10.0"` is false as strings, and the tenth minor release is
    // where a version check that never had this test starts lying.
    expect(outdatedNotice("0.9.0", "0.10.0")).toBeTruthy();
    expect(outdatedNotice("0.10.0", "0.9.0")).toBeUndefined();
  });

  test("carries across the major", () => {
    expect(outdatedNotice("0.9.9", "1.0.0")).toBeTruthy();
    expect(outdatedNotice("1.0.0", "0.9.9")).toBeUndefined();
  });

  test("says nothing about a version it cannot read", () => {
    // Whatever a server sends, a runner that cannot make sense of it stays
    // quiet: a wrong upgrade notice costs more than a missing one.
    for (const nonsense of ["", "latest", "1.2", "v1.2.3", "1.2.3.4", "1.x.0"]) {
      expect(outdatedNotice("0.1.1", nonsense), nonsense).toBeUndefined();
      expect(outdatedNotice(nonsense, "0.1.2"), nonsense).toBeUndefined();
    }
  });
});
