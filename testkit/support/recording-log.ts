/**
 * A `Logger` a test can wait a specific line out of, without polling: the
 * component already says so, the same seam crewbit-v2's own `recording()`
 * harness uses for the dispatcher's log, applied here to the runner's.
 */
import { createLogger, type Logger } from "../../src/index.ts";

export type RecordingLog = {
  log: Logger;
  /** Every line written so far, in order. */
  lines(): Record<string, unknown>[];
  /** Resolves once the first line whose `message` matches has been written. */
  line(message: string): Promise<Record<string, unknown>>;
  /** Resolves once at least `count` lines whose `message` matches have been written. */
  waitForCount(message: string, count: number): Promise<void>;
};

export function recordingLog(): RecordingLog {
  const lines: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  const log = createLogger("crewbit-runner", (raw) => {
    lines.push(JSON.parse(raw) as Record<string, unknown>);
    const ready = [...waiters];
    waiters.length = 0;
    for (const resolve of ready) resolve();
  });
  const countOf = (message: string) => lines.filter((l) => l.message === message).length;

  return {
    log,
    lines: () => [...lines],
    line: (message) =>
      new Promise((resolve) => {
        const found = lines.find((l) => l.message === message);
        if (found) {
          resolve(found);
          return;
        }
        const wait = () => {
          const line = lines.find((l) => l.message === message);
          if (line) resolve(line);
          else waiters.push(wait);
        };
        waiters.push(wait);
      }),
    waitForCount: (message, count) =>
      new Promise((resolve) => {
        if (countOf(message) >= count) {
          resolve();
          return;
        }
        const wait = () => (countOf(message) >= count ? resolve() : waiters.push(wait));
        waiters.push(wait);
      }),
  };
}
