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

/**
 * What every request builder uses instead of the raw `--server`: a value
 * already checked for a safe scheme. A guard that only checks the original
 * and then builds the URL from it anyway leaves the sink reading unexamined
 * input; building it from this call's own return value is what closes that.
 */
export function resolveServer(
  server: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const valid = validateServerUrl(server);
  if (!valid.ok) return valid;
  return { ok: true, value: stripTrailingSlashes(server) };
}
