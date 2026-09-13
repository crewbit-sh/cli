/**
 * cli#38: which grant a Job holds after a `job.status` answer.
 *
 * `nextGrant` is the one decision pulled out of `execute()` for this: whether
 * to run a Job whose keepalive and stage-transition status calls can both be
 * in flight at once through a live socket just to prove an ordering rule,
 * when a plain input/output check proves the same rule with nothing started.
 */

import { describe, expect, test } from "bun:test";
import { nextGrant } from "./index.ts";

const OLDER = {
  url: "https://github.com/acme/api.git",
  baseBranch: "main",
  branch: "crewbit/spec-1",
  token: "older-token",
  tokenExpiresAt: "2026-09-13T18:00:00Z",
};

const NEWER = { ...OLDER, token: "newer-token", tokenExpiresAt: "2026-09-13T19:00:00Z" };

describe("nextGrant", () => {
  test("an answer with no grant changes nothing", () => {
    expect(nextGrant(OLDER, {})).toBe(OLDER);
  });

  test("an answer with no grant and nothing held yet stays undefined", () => {
    expect(nextGrant(undefined, {})).toBeUndefined();
  });

  test("a grant is adopted when nothing was held yet", () => {
    expect(nextGrant(undefined, { grant: NEWER })).toBe(NEWER);
  });

  test("a grant that expires later than the one held replaces it", () => {
    expect(nextGrant(OLDER, { grant: NEWER })).toBe(NEWER);
  });

  test("a grant that does not expire later than the one held is not used", () => {
    // A reply to an earlier status tick landing after a later one's - the
    // exact reordering a live keepalive and a stage transition can produce.
    expect(nextGrant(NEWER, { grant: OLDER })).toBe(NEWER);
  });

  test("an identical expiry is not a replacement either", () => {
    const sameExpiry = { ...OLDER, token: "same-expiry-different-token" };
    expect(nextGrant(OLDER, { grant: sameExpiry })).toBe(OLDER);
  });
});
