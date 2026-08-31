/**
 * Waiting that a signal can cut short.
 *
 * Its own module because two things wait: the engine between spawns, and the
 * completion between attempts at handing it over. Both are cancelled by the same
 * kind of event, and a second copy of twelve lines is how the two drift.
 */

/**
 * Waits, unless the signal fires first. `true` when the delay elapsed, `false`
 * when the signal fired.
 *
 * The timer is cleared on the abort rather than left to fire into a resolved
 * promise: a runner told to stop must not be held open by a wait for work
 * nobody wants any more.
 */
export function waited(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abandon = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abandon);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", abandon, { once: true });
  });
}
