/**
 * `--server` names a self-hosted Crewbit server, so it cannot be pinned to one
 * host; the scheme is the only thing worth trusting it on. Restricting it to
 * http/https rules out a value like `file://` or `gopher://` reaching `fetch`
 * with a Bearer token attached.
 */
export function validateServerUrl(value: string): { ok: true } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: `--server is not a URL: "${value}"` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: `--server must be http or https, not "${parsed.protocol}"` };
  }
  return { ok: true };
}

/** Every request builder strips this before appending its own path; done once, without a regex. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}
