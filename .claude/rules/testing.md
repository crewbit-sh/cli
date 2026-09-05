# What counts as a test here

This rule has two readers. The code stage writes against it, and the eval stage
judges against it. They must apply the same standard, which is why it is one
document.

## Failing first

Write the test, watch it fail, then implement. A test written after the code
tends to assert what the code does rather than what was wanted, and it passes
for both.

A test that has never failed has proven nothing. If you cannot make it fail by
breaking the thing it covers, it is not testing that thing.

## Assert behaviour, not implementation

The test names an input and an expected outcome. It does not name a private
function, count calls to an internal helper, or assert on the shape of an
intermediate value.

The check: would this test survive a rewrite of the internals that kept the
behaviour? If not, it is a maintenance cost sold as coverage, and it will be
deleted the first time someone refactors.

Test through the seam the caller uses. A pure function is tested by calling it. A
component reached over a socket is tested over the socket.

## What to cover

**The stated acceptance criteria**, one test each at minimum. If a criterion has
no test, either it was not testable and should have failed the readiness gate, or
it was skipped.

**The edge cases named in the plan**, and the ones you find while implementing.
The recurring ones worth checking every time: empty input, the second call, the
call that arrives twice, the concurrent call, and the failure of the thing you
depend on.

**The boundary you are trusting.** Validation of untrusted input, anything that
prevents data loss, and anything touching money or credentials get a test even
when the change looks trivial. In this package that boundary is not abstract:
the runner executes model-authored code on somebody's machine, and what keeps
that bounded is asserted in `src/boundary.test.ts` rather than reviewed.

## The shape: unit tests carry the coverage, integration proves the flow

A unit test names an input and an outcome and needs nothing running. Every branch
a module can take is reachable that way, so that is where coverage comes from: the
goal is every decision in the module covered, and a branch nothing reaches is
either dead or a test nobody wrote.

"Nothing running" has one exception here, and it is deliberate: `src/boundary.test.ts`
and `src/cli.test.ts` spawn `src/cli.ts` under node. That is how the rule that
this package runs on a runtime other than bun is checked at all, and it is why
`.github/workflows/release.yml` installs node next to bun. Both would stay green
if node went away, and the guarantee would be gone.

An integration test is the other job. Once a feature or a user-visible flow is
complete, one test exercises the integrated path — the real components, talking to
each other, doing the thing a user would do. It catches the two halves that each
work and do not fit, which is the expensive kind of bug because it is found late.
One per flow is usually enough, and it is the test that will be worth the most in
a year.

**Both, and not one instead of the other.** The failure this rule exists to stop
is coverage reached by integration: a hundred tests that each start a server, a
socket and a runner to assert one branch. They are slow, they fail for reasons
that are not the thing they test, and they hide the module that has no test at
all — a module covered only from outside looks covered, and the coverage belongs
to the flow rather than to it.

This package is currently the right way round, which is the state to hold rather
than to reach: every module under `src/` has its unit tests in the same
directory, and the nine integrated flows in `testkit/` are a small fraction of
the files. The day a branch is reachable only from `testkit/`, the module that
owns that branch has no test of its own, whatever the totals say.

So when a test needs a server to reach a branch, that is a signal about the
design and not a cost to pay. Something the module decides is only reachable
through the wire, and pulling it out is usually a smaller change than the test.

## Tests live with the code they test

A module's unit tests sit in the same directory as the module and are named for
it: `src/runner/batcher.ts` is covered by `src/runner/batcher.test.ts`, and the
release tooling in `tools/release/` is covered the same way. They run without a
server, a socket or a runner being started.

`testkit/` is for integration only: the flows that cross the wire, where the
point is the components meeting. A file in there is `*.integration.test.ts` and
drives the real runner against `testkit/server-double.ts`, with the doubles in
`testkit/support/` standing in for the engine and the log. `testkit/server-double.test.ts`
is the one file in there that is not integration, and it is not an exception: it
unit-tests the double, and it sits beside the double, which is the same rule.

A file in `testkit/` that could have been a unit test beside its module is in the
wrong place, and the tell is that it starts something to assert a branch.

## Running them

`bun run check`, then `bun run typecheck`, then `bun test --timeout 60000` — the
order `.github/workflows/release.yml` runs them before it cuts a release, so
running them in that order locally is running what the release runs. The timeout
is there for `testkit/`, which dials a real socket and holds the slow files.

## What does not count

- **A test that cannot fail.** Asserting a constant, or asserting on a mock you
  configured in the same test to return exactly that.
- **A snapshot of unexamined output.** Recording what the code happens to
  produce documents the bug along with the behaviour.
- **A test for something the type system already guarantees.**
- **A skipped or commented-out test.** Delete it or fix it. A disabled test is a
  claim of coverage with none behind it.
- **Coverage as a goal.** The number goes up by testing trivial code, which is
  exactly the code that does not need it.

## A test that asserts something is gone

Removing a thing does not earn a test that it is missing. A command deleted from
`src/cli.ts` is gone from the branch that dispatched it and from the usage text
both, and a test per removed name only ever fails for an uninteresting reason.

What is worth one is the behaviour that used to be reached through the thing you
removed. If a command had another way in, the test belongs there, and naming
which test covers it is the work. If nothing covers it, that is the test to
write.

## When a test is genuinely hard to write

Say so, and say why, rather than skipping it silently or writing one that passes
without checking anything. A hard-to-test change is usually a design signal, and
naming it is how it gets addressed instead of accumulating.
