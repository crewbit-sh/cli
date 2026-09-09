/**
 * Driving a Run from a terminal, end to end: the real binary under node, a
 * real socket, and a server that answers the way `crewbit-v2`'s routes do.
 *
 * The unit tests beside `src/commands/run.ts` cover what each request is. What
 * only this can prove is the other half of the acceptance criterion — that the
 * Run's state reaches the terminal on success, and that the server's own
 * refusal reaches it with a non-zero exit — because both are `process.exit`
 * and `console.log` in a process nobody imported.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const WORK = mkdtempSync(join(tmpdir(), "crewbit-run-commands-"));

type Seen = { method: string; path: string; authorization?: string; body: string };

/** What the next request is answered with, set by whichever test is driving. */
let answer: { status: number; body: string } = { status: 200, body: "{}" };
let seen: Seen[] = [];
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function crewbit(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // The credential on the machine running this must not be what the binary
    // picks up, the same reason `src/cli.test.ts` scrubs it.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: WORK, XDG_CONFIG_HOME: WORK };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CREWBIT_")) delete env[key];
    }
    const child = spawn("node", [CLI, ...args, "--server", origin], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("driving one Run from a terminal", () => {
  beforeAll(() => {
    seen = [];
  });

  test("`run cancel` reaches the route and says what the Run is now", async () => {
    seen = [];
    answer = { status: 200, body: JSON.stringify({ runId: "run_1", state: "cancelled" }) };

    const { code, out } = await crewbit("run", "cancel", "run_1", "--token", "crw_t");

    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/runs/run_1/cancel",
        authorization: "Bearer crw_t",
        body: "{}",
      },
    ]);
    expect(out).toContain("run_1");
    expect(out).toContain("cancelled");
    expect(code).toBe(0);
  });

  test("a refusal is the server's own words, and the exit code is not zero", async () => {
    seen = [];
    answer = { status: 409, body: "nothing is waiting on an answer" };

    const { code, out } = await crewbit(
      "run",
      "answer",
      "run_1",
      "--token",
      "crw_t",
      "--data",
      '{"choice":"the second one"}',
    );

    expect(seen[0]?.path).toBe("/api/runs/run_1/answer");
    expect(out).toContain("nothing is waiting on an answer");
    expect(code).not.toBe(0);
  });

  test("`run answer --file` puts the file's object on the wire", async () => {
    seen = [];
    answer = { status: 200, body: JSON.stringify({ runId: "run_1", state: "coding" }) };
    const path = join(WORK, "answer.json");
    writeFileSync(path, JSON.stringify({ choice: "the second one" }));

    const { code, out } = await crewbit(
      "run",
      "answer",
      "run_1",
      "--token",
      "crw_t",
      "--file",
      path,
    );

    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ choice: "the second one" });
    expect(out).toContain("coding");
    expect(code).toBe(0);
  });

  test("`run now` posts to the route the server documents, not to the word typed", async () => {
    seen = [];
    answer = { status: 200, body: JSON.stringify({ runId: "run_1", state: "planning" }) };

    const { code } = await crewbit("run", "now", "run_1", "--token", "crw_t");

    expect(seen[0]?.path).toBe("/api/runs/run_1/run-now");
    expect(code).toBe(0);
  });

  test("`spec run` starts one and says which Run it is", async () => {
    seen = [];
    answer = { status: 200, body: JSON.stringify({ runId: "run_9", state: "planning" }) };

    const { code, out } = await crewbit("spec", "run", "acme/api#12", "--token", "crw_t");

    expect(seen[0]?.path).toBe("/api/specs/run");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ spec: "acme/api#12" });
    expect(out).toContain("run_9");
    expect(out).toContain("planning");
    expect(code).toBe(0);
  });

  test("--output json prints the server's own body, not a rendering of it", async () => {
    seen = [];
    answer = { status: 200, body: JSON.stringify({ runId: "run_1", state: "evaluating" }) };

    const { code, out } = await crewbit(
      "run",
      "judge",
      "run_1",
      "--token",
      "crw_t",
      "--output",
      "json",
    );

    expect(JSON.parse(out)).toEqual({ runId: "run_1", state: "evaluating" });
    expect(code).toBe(0);
  });
});
