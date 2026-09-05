import { describe, expect, test } from "bun:test";
import { preExistingFailures } from "./pre-existing.ts";

// Recorded from this project's own suites, not invented: a made-up format is
// a format nobody's runner ever prints, and this is exactly what #9 exists to
// tell apart from noise.
const BUN_REPORT = `exit 1
(fail) what the binary is asked to do > \`runner\` is what runs one, and it says what it is missing [3450.96ms]
(fail) what the binary is asked to do > \`project\` routes, and says what it is missing rather than the usage [1899.19ms]

 18 pass
 3 fail
 50 expect() calls
Ran 21 tests across 1 file. [8.45s]`;

const VITEST_REPORT = `exit 1
 FAIL  packages/site/src/files.test.ts:293:3 > nothing goes out with a blank still in it > and none of them carries an em dash
AssertionError: expected [ …(72) ] to deeply equal []

 Test Files  1 failed (1)
      Tests  1 failed | 16 passed (17)`;

describe("preExistingFailures", () => {
  test("a Bun failure the base already has is pre-existing", () => {
    const branch = `exit 1
(fail) what the binary is asked to do > \`runner\` is what runs one, and it says what it is missing [3450.96ms]

 20 pass
 1 fail`;

    const shared = preExistingFailures(branch, BUN_REPORT);

    expect(shared).toEqual([
      "what the binary is asked to do > `runner` is what runs one, and it says what it is missing",
    ]);
  });

  test("a Bun failure the base does not have keeps today's behaviour", () => {
    const branch = `exit 1
(fail) what the binary is asked to do > a brand new test this branch broke [12.00ms]

 20 pass
 1 fail`;

    expect(preExistingFailures(branch, BUN_REPORT)).toBeUndefined();
  });

  test("a mix where the branch keeps a base failure but adds one of its own is not pre-existing", () => {
    const branch = `exit 1
(fail) what the binary is asked to do > \`runner\` is what runs one, and it says what it is missing [3450.96ms]
(fail) what the binary is asked to do > a brand new test this branch broke [12.00ms]

 19 pass
 2 fail`;

    // Both are pre-existing except the new one, and one new failure is enough
    // to keep today's behaviour: no partial credit.
    expect(preExistingFailures(branch, BUN_REPORT)).toBeUndefined();
  });

  test("a vitest failure the base already has is pre-existing, durations and line numbers ignored", () => {
    // Same test, different line: a reformat that moved the assertion two
    // lines down must not turn a pre-existing failure into a new one.
    const branch = `exit 1
 FAIL  packages/site/src/files.test.ts:295:5 > nothing goes out with a blank still in it > and none of them carries an em dash
AssertionError: expected [ …(70) ] to deeply equal []

 Test Files  1 failed (1)
      Tests  1 failed | 16 passed (17)`;

    expect(preExistingFailures(branch, VITEST_REPORT)).toEqual([
      "nothing goes out with a blank still in it > and none of them carries an em dash",
    ]);
  });

  test("jest's own marker names the same failure", () => {
    const base = "exit 1\n  ✕ adds two numbers (4 ms)\n";
    const branch = "exit 1\n  ✕ adds two numbers (7 ms)\n";

    expect(preExistingFailures(branch, base)).toEqual(["adds two numbers"]);
  });

  test("pytest's own marker names the same failure", () => {
    const base = "exit 1\nFAILED tests/test_foo.py::test_bar - AssertionError\n";
    const branch = "exit 1\nFAILED tests/test_foo.py::test_bar - AssertionError\n";

    expect(preExistingFailures(branch, base)).toEqual(["tests/test_foo.py::test_bar"]);
  });

  test("go test's own marker names the same failure", () => {
    const base = "exit 1\n--- FAIL: TestSomething (0.00s)\n";
    const branch = "exit 1\n--- FAIL: TestSomething (0.01s)\n";

    expect(preExistingFailures(branch, base)).toEqual(["TestSomething"]);
  });

  test("a shape with no recognisable marker falls back to the whole output, normalised", () => {
    const base = "exit 2\nsome_linter: unexpected token [4.20s]\n";
    const branch = "exit 2\nsome_linter: unexpected token [7.90s]\n";

    // Different durations, same shape: normalised, they read as one failure.
    expect(preExistingFailures(branch, base)).toEqual(["exit 2 some_linter: unexpected token"]);
  });

  test("the fallback tells apart two outputs that are genuinely different", () => {
    const base = "exit 2\nsome_linter: unexpected token\n";
    const branch = "exit 2\nsome_other_tool: a completely different complaint\n";

    expect(preExistingFailures(branch, base)).toBeUndefined();
  });

  test("named failures on the branch never match the base's whole-output fallback", () => {
    // The base failed in a shape nothing here recognises, the branch failed a
    // named test: treating those as the same failure would be a coincidence,
    // not a match, so they must not be pre-existing.
    const base = "exit 2\nsome_linter: unexpected token\n";
    const branch = "exit 1\n(fail) a test the linter would never run [1.00ms]\n";

    expect(preExistingFailures(branch, base)).toBeUndefined();
  });
});
