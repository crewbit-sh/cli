import { runRunner, RUNNER_USAGE } from "./commands/runner.ts";
import { RUNNER_VERSION } from "./runner/index.ts";

const USAGE = `crewbit - run Crewbit work with your own Claude Code

  crewbit runner [options]   connect and execute the work you are given

${RUNNER_USAGE}
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
if (command !== "runner") {
  console.log(USAGE);
  if (command) console.log(`\ncrewbit has no "${command}" command.`);
  else console.log("\nNothing to do: the runner is `crewbit runner`.");
  process.exit(1);
}

await runRunner(argv.slice(1));
