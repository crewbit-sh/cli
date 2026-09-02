/**
 * What the package publishes, and nothing else.
 *
 * `crewbit-v2` drives this from its own suite and pins a tag, so this list is a
 * contract with another repository rather than a convenience: a name dropped
 * here is discovered over there, at its next release. `index.test.ts` asserts
 * the whole of it.
 */

export { createLogger, errorFields, type Logger } from "./log.ts";
export { buildArgs, buildEnv, claudeCliEngine } from "./runner/engine/claude-cli.ts";
export { type FakeEngine, fakeEngine } from "./runner/engine/fake.ts";
export { consumeStream, failedResult, parseLine } from "./runner/engine/stream.ts";
export type { Engine, EngineEvent, EngineResult, EngineRun } from "./runner/engine/types.ts";
export {
  REFUSED_HANDSHAKE,
  RUNNER_VERSION,
  type RunnerHandle,
  type RunnerOptions,
  startRunner,
} from "./runner/index.ts";
