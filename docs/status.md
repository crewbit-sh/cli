# What is knowingly unfinished

The one file that carries what is not done. Everything else about this package is
answerable by reading the tree.

## The layout is being given a shape, and it is half done

`crewbit runner` landed in `b5a42b0`, and more subcommands are coming. The flat
`src/*.ts` model has no room for them: `cli.ts` currently parses arguments *and*
wires the runner, so a second command would have to be a flag on the first.

The shape decided, and agreed before any of it was written:

```
src/
  index.ts          what the package publishes, and nothing else
  cli.ts            argv -> which command, and nothing else
  commands/
    runner.ts       what `crewbit runner` does: flags, wiring, engine choice, log
  runner/
    index.ts        startRunner
    batcher.ts  completion.ts  git.ts  outcome.ts
    reason.ts   verify.ts      wait.ts  workspace.ts
    engine/
  log.ts            output format, everybody's
  latest.ts  version.ts        the newer-release notice, which is the binary's
```

Three roles that are one thing today: what the package publishes, what the
binary accepts, and what a command does.

`latest.ts` and `version.ts` stay at the top on purpose. They belong to the
binary's shell rather than to any command, and giving two files a directory for
symmetry is inventing structure. They get a home when a third joins them.

### Phase 1, the change of address. Not started

Nine modules and `engine/` move under `src/runner/`, and `index.ts` becomes the
facade. Twelve files, above the five a phase is meant to hold, and said out loud
rather than hidden: every edit is a `git mv` and an import path.

**`exports` stays `./src/index.ts`.** That is deliberate, and it is why the
facade exists: the package will publish more than the runner.

### Phase 2, the commands directory. Not started

`cli.ts` keeps argv and dispatch; the runner command's wiring moves to
`commands/runner.ts`. Small, and it is the phase that gives the second
subcommand somewhere to be born.

### Phase 3, the 961-line file. Deliberately not scheduled

`src/index.ts` is 961 lines, close to double the other nine put together. It is
the most flat thing in the repository, and moving it into a directory does not
change that. Splitting it is its own piece with a design decision inside, and
folding it into the change of address would produce a diff nobody reviews.

## Two things measured while planning, so nobody measures them again

**There are no dead exports.** Checked before Phase 1, because the rule is to
delete before restructuring. The three names with no external reference —
`RunnerOptions`, `RunnerHandle`, `EngineRun` — are the types of `startRunner`'s
own signature, so a consumer typing a variable needs them.

**Nothing tests the published surface.** `index.test.ts` imports only
`RUNNER_VERSION`. The facade is `crewbit-v2`'s contract, and if a move breaks it
the discovery happens over there, at the next release, because that repository
pins a tag. Phase 1 should add a test that imports every published name through
`./index.ts` the way a consumer does. That is what makes the move safe rather
than hopeful.

## The command rename is not finished outside this repository

`crewbit --token …` no longer runs anything. Three places still teach the old
form, all in `crewbit-v2`:

- `packages/web/src/pages/runners.ts`, the block shown on the credentials page
- `packages/site/src/pages/guides.ts`
- the test covering that guide

**The order matters in the direction that is easy to get backwards.** A page must
not teach `crewbit runner` before a release exists that accepts it: the newest
tag is `v0.3.0`, which understands only the old form. Cut `v0.4.0` from `main`
first, then update the three.
