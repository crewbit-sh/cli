# What is knowingly unfinished

The one file that carries what is not done. Everything else about this package is
answerable by reading the tree.

## The 961-line file is the flat thing that is left

`src/runner/index.ts` is 961 lines, close to double the other nine put together.
The layout around it is done: the package's surface is `src/index.ts`, the binary
takes argv in `src/cli.ts`, and a command is a file under `src/commands/`.

Splitting it is its own piece with a design decision inside, which is why it was
kept out of the move: folding it in would have produced a diff nobody reviews.

`latest.ts` and `version.ts` stay at the top of `src/` on purpose. They belong to
the binary's shell rather than to any command, and giving two files a directory
for symmetry is inventing structure. They get a home when a third joins them.

## One thing measured while planning, so nobody measures it again

**There are no dead exports.** Checked before the move, because the rule is to
delete before restructuring. The three names with no external
reference (`RunnerOptions`, `RunnerHandle`, `EngineRun`) are the types of `startRunner`'s
own signature, so a consumer typing a variable needs them.
