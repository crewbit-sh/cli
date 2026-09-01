/**
 * Which release is newest, asked of GitHub.
 *
 * The alternative was the handshake: the server already receives the runner's
 * `version`, and could answer with the newest one at no network cost. It was
 * refused because it puts a field on the wire and takes `@crewbit/protocol` to
 * a minor, across three repositories, for a notice. What that alternative
 * bought is what the two rules below have to buy back instead, because a runner
 * asking a third party is the thing the trust boundary exists to keep rare:
 *
 * **It never blocks and it never retries.** Runners run behind allowlists.
 * `fixtures/stream-api-error.jsonl` is a recorded 403 from one, and a runner
 * that can reach its own server but not `api.github.com` must lose no time and
 * make no noise about it.
 *
 * **Once per start, never on a timer.** Unauthenticated GitHub allows sixty
 * requests an hour per address, and a team behind one address would spend that
 * on version checks.
 */

const LATEST = "https://api.github.com/repos/crewbit-sh/cli/releases/latest";
/** Long enough for a slow answer, short enough that a black hole costs nothing. */
const PATIENCE_MS = 2_000;

/** Injected so this is testable without the network, which is the whole seam. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The newest released version, or nothing.
 *
 * Nothing for every failure there is: refused, blocked, rate-limited, slow,
 * malformed. The caller has no branch for why, because there is nothing a
 * person can do about any of them and a runner has work to get on with.
 */
export async function newestRelease(get: Fetch = fetch): Promise<string | undefined> {
  try {
    const answer = await get(LATEST, {
      headers: { accept: "application/vnd.github+json", "user-agent": "crewbit-runner" },
      signal: AbortSignal.timeout(PATIENCE_MS),
    });
    if (!answer.ok) return undefined;
    const body = (await answer.json()) as { tag_name?: unknown };
    // Releases are tagged `v0.2.0` and versions are written `0.2.0`.
    return typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : undefined;
  } catch {
    return undefined;
  }
}
