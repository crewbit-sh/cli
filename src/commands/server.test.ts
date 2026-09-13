import { describe, expect, test } from "bun:test";
import { stripTrailingSlashes, validateServerUrl } from "./server.ts";

describe("stripTrailingSlashes", () => {
  test("removes one trailing slash", () => {
    expect(stripTrailingSlashes("https://app.crewbit.sh/")).toBe("https://app.crewbit.sh");
  });

  test("removes more than one", () => {
    expect(stripTrailingSlashes("https://app.crewbit.sh///")).toBe("https://app.crewbit.sh");
  });

  test("leaves a value with none alone", () => {
    expect(stripTrailingSlashes("https://app.crewbit.sh")).toBe("https://app.crewbit.sh");
  });
});

describe("validateServerUrl", () => {
  test("accepts https", () => {
    expect(validateServerUrl("https://app.crewbit.sh").ok).toBe(true);
  });

  test("accepts http, for a self-hosted server with no certificate", () => {
    expect(validateServerUrl("http://localhost:4000").ok).toBe(true);
  });

  test("refuses a scheme that is neither, naming it", () => {
    const result = validateServerUrl("ws://127.0.0.1:1");

    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("http");
  });

  test("refuses a value that is not a URL at all", () => {
    const result = validateServerUrl("not a url");

    expect(result.ok).toBe(false);
  });
});
