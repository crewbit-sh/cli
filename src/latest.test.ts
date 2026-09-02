import { describe, expect, test } from "bun:test";
import { type Fetch, newestRelease } from "./latest.ts";

const answering =
  (body: unknown, ok = true): Fetch =>
  async () =>
    ({ ok, json: async () => body }) as Response;

describe("asking GitHub which release is newest", () => {
  test("reads the tag, without the v a version does not carry", async () => {
    expect(await newestRelease(answering({ tag_name: "v0.2.0" }))).toBe("0.2.0");
  });

  test("says nothing when the answer is not one", async () => {
    expect(await newestRelease(answering({ message: "Not Found" }, false))).toBeUndefined();
  });

  test("says nothing when the answer is not the shape it expects", async () => {
    expect(await newestRelease(answering({ tag_name: 3 }))).toBeUndefined();
    expect(await newestRelease(answering({}))).toBeUndefined();
  });

  test("says nothing when it cannot be reached at all", async () => {
    const blocked: Fetch = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));

    // The allowlist case, and the one this has to be silent about: a runner
    // that cannot reach GitHub still has a server it can reach and work to do.
    expect(await newestRelease(blocked)).toBeUndefined();
  });

  test("asks once and gives up, rather than spending a rate limit on retries", async () => {
    let asked = 0;
    const refusing: Fetch = () => {
      asked += 1;
      return Promise.reject(new Error("403 rate limit exceeded"));
    };

    await newestRelease(refusing);

    // Sixty an hour per address is what a team behind one address shares.
    expect(asked).toBe(1);
  });
});
