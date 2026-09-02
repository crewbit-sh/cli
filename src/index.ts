/**
 * What the package publishes. `crewbit-v2` pins a tag, so a name dropped here is
 * discovered over there at its next release; `index.test.ts` asserts the list.
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
