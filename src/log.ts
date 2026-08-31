/**
 * One JSON object per line on stdout.
 *
 * The same format the server writes, deliberately duplicated rather than shared:
 * this package declares `@crewbit/protocol` and nothing else, and a logger is not
 * protocol. Twenty lines in two places costs less than a third package coupling
 * two that are meant to be publishable on their own.
 *
 * No Bun API here either, so the runner still runs under Node.
 */

export type Status = "info" | "warning" | "error";

export type Logger = {
  info(message: string, fields?: Fields): void;
  warning(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
};

type Fields = Record<string, unknown>;

/** `write` is injectable so a test can read what was emitted. */
export function createLogger(service: string, write: (line: string) => void = toStdout): Logger {
  const emit = (status: Status, message: string, fields: Fields = {}) => {
    const base = {
      timestamp: new Date().toISOString(),
      status,
      service,
      ddsource: "crewbit",
      message,
    };
    let line: string;
    try {
      line = JSON.stringify({ ...base, ...fields });
    } catch (cause) {
      // An unserialisable field must not take a runner down mid-Job, and dropping
      // the event entirely would hide whatever was being reported.
      line = JSON.stringify({
        ...base,
        "log.fields_dropped": cause instanceof Error ? cause.message : String(cause),
      });
    }
    write(`${line}\n`);
  };

  return {
    info: (message, fields) => emit("info", message, fields),
    warning: (message, fields) => emit("warning", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

function toStdout(line: string): void {
  process.stdout.write(line);
}

/** What an unknown thrown value contributes to a log line. */
export function errorFields(cause: unknown): Fields {
  if (cause instanceof Error) {
    return { "error.message": cause.message, "error.kind": cause.name, "error.stack": cause.stack };
  }
  return { "error.message": String(cause) };
}
