/**
 * Telling a verify failure the base commit already has apart from one this
 * change made. #9: nothing here talks to git or spawns a process - the
 * runner reruns the same verify command on the merge-base and hands both
 * reports here, so this stays a pure function on recorded text.
 */

/**
 * One line from a test runner's own failure output, and the name it names.
 * Bun, vitest, jest, pytest and go test each print a failure differently;
 * this tries each shape in turn and takes the first that matches.
 */
const MARKERS: Array<{ pattern: RegExp; name: (match: RegExpMatchArray) => string }> = [
  // Bun: "(fail) describe > test [12.34ms]"
  { pattern: /^\(fail\)\s+(.+)$/, name: (m) => m[1] ?? "" },
  // vitest: " FAIL  src/foo.test.ts:12:3 > describe > test" - the file and its
  // line:col are one whitespace-free token, discarded rather than captured.
  { pattern: /^\s*FAIL\s+\S+\s*>\s*(.+)$/, name: (m) => m[1] ?? "" },
  // jest, one failing test: "  ✕ test name (12 ms)"
  { pattern: /^\s*[✕✗×]\s+(.+)$/, name: (m) => m[1] ?? "" },
  // jest, a failure's own heading: "  ● describe › test"
  { pattern: /^\s*●\s+(.+)$/, name: (m) => m[1] ?? "" },
  // pytest: "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
  { pattern: /^FAILED\s+(\S+)/, name: (m) => m[1] ?? "" },
  // go test: "--- FAIL: TestSomething (0.00s)"
  { pattern: /^---\s*FAIL:\s+(\S+)/, name: (m) => m[1] ?? "" },
];

/**
 * Strips what a rerun cannot hold still: how long it took, and (vitest) which
 * line an assertion sits on. Without this, a suite that runs a few
 * milliseconds slower the second time never matches itself.
 */
function normalise(text: string): string {
  return text
    .replace(/\[[\d.]+\s*m?s\]/g, "")
    .replace(/\(\d+(?:\.\d+)?\s*m?s\)/g, "")
    .replace(/:\d+:\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFailures(report: string): string[] {
  const found: string[] = [];
  for (const line of report.split("\n")) {
    for (const { pattern, name } of MARKERS) {
      const match = line.match(pattern);
      if (match) {
        found.push(normalise(name(match)));
        break;
      }
    }
  }
  return [...new Set(found)].filter(Boolean);
}

/**
 * One signature per failure the runner can name, or the whole report as its
 * own single signature when nothing named extracts - an unrecognised shape
 * still deserves a comparison, just a cruder one.
 */
function signatures(report: string): string[] {
  const names = extractFailures(report);
  return names.length > 0 ? names : [normalise(report)];
}

/**
 * The branch's own failures that the base commit already has, or `undefined`
 * when the branch added at least one the base does not - that one is this
 * change's own failure, and no number of shared ones excuses it.
 */
export function preExistingFailures(
  branchReport: string,
  baseReport: string,
): string[] | undefined {
  const branch = signatures(branchReport);
  const base = new Set(signatures(baseReport));
  const shared = branch.filter((name) => base.has(name));

  return shared.length === branch.length ? shared : undefined;
}
