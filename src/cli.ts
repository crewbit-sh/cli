import { PROJECT_USAGE, runProject } from "./commands/project.ts";
import { RUN_USAGE, runRun } from "./commands/run.ts";
import { RUNNER_USAGE, runRunner } from "./commands/runner.ts";
import { runSpec, SPEC_USAGE } from "./commands/spec.ts";
import { RUNNER_VERSION } from "./runner/index.ts";

const USAGE = `crewbit - run Crewbit work with your own Claude Code

  crewbit runner [options]      connect and execute the work you are given
${RUNNER_USAGE}

  crewbit run view <id>         read one Run for investigation
${RUN_USAGE}

  crewbit project list          the Projects this credential's org owns
  crewbit project view <id>     one Project, its sources and what each answers for
${PROJECT_USAGE}

  crewbit spec list             the Specs a Project's sources are offering
  crewbit spec plan <ref>       start planning one, as acme/api#12
${SPEC_USAGE}

  --version
`;

const argv = process.argv.slice(2);

// Read before the command, because "what are you" and "how do I use you" are
// questions about the binary rather than about any one thing it does.
if (argv.includes("--version")) {
  console.log(RUNNER_VERSION);
  process.exit(0);
}

if (argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

// A flag in first position is somebody running `crewbit --token …`, the whole
// interface before the runner became a word, so it is not read as a command.
const command = argv[0]?.startsWith("-") ? undefined : argv[0];

// No command is refused rather than defaulted to the runner: a binary that
// starts, takes no work and looks healthy is the worst answer available to
// somebody whose service file still says the old form.
if (command === "runner") {
  await runRunner(argv.slice(1));
} else if (command === "run") {
  await runRun(argv.slice(1));
} else if (command === "project") {
  await runProject(argv.slice(1));
} else if (command === "spec") {
  await runSpec(argv.slice(1));
} else {
  console.log(USAGE);
  if (command) console.log(`\ncrewbit has no "${command}" command.`);
  else console.log("\nNothing to do: the runner is `crewbit runner`.");
  process.exit(1);
}
