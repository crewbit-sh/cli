# What counts as a test here

This rule has two readers. The code stage writes against it, and the eval stage
judges against it. They must apply the same standard, which is why it is one
document.

The suite is `bun test --timeout 60000`, and the two checks beside it are
`bun run check` (Biome) and `bun run typecheck` (`tsc --noEmit`). Run all three;
`.github/workflows/release.yml` runs them in that order before it builds
anything, so a change that only passes the tests is a change that fails the
release.

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
runner reached over a socket is tested over the socket.

## What to cover

**The stated acceptance criteria**, one test each at minimum. If a criterion has
no test, either it was not testable and should have failed the readiness gate, or
it was skipped.

**The edge cases named in the plan**, and the ones you find while implementing.
The recurring ones worth checking every time: empty input, the second call, the
call that arrives twice, the concurrent call, and the failure of the thing you
depend on. This runner lives on the last of those — the server that goes away
mid-Job, the engine that stops on a rate limit, the completion nobody takes —
so its absence from a plan is a gap and not a simplification.

**The boundary you are trusting.** Validation of untrusted input, anything that
prevents data loss, and anything touching money or credentials get a test even
when the change looks trivial. Here that is argv and the frames off the socket,
the batcher's tail on a stop, and the token: `src/boundary.test.ts` holds the
first of those for the whole package.

## The shape: unit tests carry the coverage, integration proves the flow

A unit test names an input and an outcome and needs nothing started. Every branch
a module can take is reachable that way, so that is where coverage comes from: the
goal is every decision in the module covered, and a branch nothing reaches is
either dead or a test nobody wrote.

An integration test is the other job. Once a feature or a user-visible flow is
complete, one test exercises the integrated path — the real components, talking to
each other, doing the thing a user would do. Here that is `startRunner` against
`testkit/server-double.ts` over a real socket. It catches the two halves that each
work and do not fit, which is the expensive kind of bug because it is found late.
One per flow is usually enough, and it is the test that will be worth the most in
a year.

**Both, and not one instead of the other.** The failure this rule exists to stop
is coverage reached by integration: a hundred tests that each start a server, a
socket and a runner to assert one branch. They are slow, they fail for reasons
that are not the thing they test, and they hide the module that has no test at
all. This package has one such module today, and it is the largest: nearly
everything under `src/` has a test beside it, but `src/runner/index.ts` — the
file `docs/status.md` names as the flat thing still left — has no `index.test.ts`
of its own, and every decision it makes is reachable only by standing up a server
and a runner. That is the shape to stop growing, not to copy.

So when a test needs a server to reach a branch, that is a signal about the
design and not a cost to pay. Something the module decides is only reachable
through the wire, and pulling it out is usually a smaller change than the test.

## Tests live with the code they test

A module's unit test sits beside it: `src/runner/reason.test.ts` next to
`src/runner/reason.ts`, and the same under `tools/release/`. They run with
nothing started and nothing else built.

`testkit/` is for integration only — the `*.integration.test.ts` files that stand
up `testkit/server-double.ts` and a real runner and prove a flow end to end. Two
things in there are not that and should not be read as precedent:
`testkit/server-double.test.ts` is the double's own unit test, because a double
nobody tests is a second implementation nobody trusts, and `testkit/support/`
holds helpers rather than tests. A file in `testkit/` that starts a server to
reach one branch belongs beside its module instead, and the tell is that it
starts something to assert a branch.

One carve-out, because the tree has it on purpose: a test asserting a property of
the whole package rather than of a module belongs in `src/` even though it spawns
something. `src/boundary.test.ts` and `src/cli.test.ts` run the CLI under node —
`.github/workflows/release.yml` installs node for exactly that reason — because
the property is "this package does not depend on Bun" and "this binary's argv
surface is what it says", and neither has a module to sit beside.

Reuse the utilities that exist rather than building a third of each:

- `src/runner/engine/fake.ts` replays a recorded stream through the real parser,
  with no process and no credentials; the recordings are in `fixtures/`.
- `testkit/support/blocking-engine.ts` holds a Job mid-run, for the flows about
  what arrives while work is in hand.
- `testkit/support/recording-log.ts` waits on and asserts a log line.

## What does not count

- **A test that cannot fail.** Asserting a constant, or asserting on a double you
  configured in the same test to return exactly that.
- **A snapshot of unexamined output.** Recording what the code happens to
  produce documents the bug along with the behaviour. The `fixtures/*.jsonl`
  recordings are not this: they are captured engine output somebody read, and
  the assertions are written against what the runner should make of them.
- **A test for something the type system already guarantees.** `bun run typecheck`
  is `tsc --noEmit` over this tree, and `bun run check` is Biome; neither a type
  error nor a formatting one belongs in an assertion.
- **A skipped or commented-out test.** Delete it or fix it. A disabled test is a
  claim of coverage with none behind it.
- **Coverage as a goal.** The number goes up by testing trivial code, which is
  exactly the code that does not need it.

## A test that asserts something is gone

Removing a thing does not earn a test that it is missing. A command deleted from
the command chain in `src/cli.ts` and from the `USAGE` string beside it is gone
twice over, and a test per removed name only ever fails for an uninteresting
reason.

What is worth one is the behaviour that used to be reached through the thing you
removed. If a command had an equivalent under another verb, the test belongs
there, and naming which test covers it is the work. If nothing covers it, that is
the test to write.

## When a test is genuinely hard to write

Say so, and say why, rather than skipping it silently or writing one that passes
without checking anything. A hard-to-test change is usually a design signal, and
naming it is how it gets addressed instead of accumulating.
