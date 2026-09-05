# What a plan has to contain

A plan is a brief another engineer could implement without asking you anything.
It is not a description of the problem, and it is not code.

## Ground it in real files first

Explore before planning. Read the files you are going to name, and grep for the
patterns the codebase already uses.

**Every path you name must exist**, unless you are explicitly adding it, and then
say so. A plan citing a file that is not there is the strongest available signal
that the plan was written from imagination, and it will be rejected.

Reuse what is there. If the codebase already has a helper, a client, a test
utility or a convention for the thing you need, the plan uses it and says which.
Proposing a second way to do something the project already does is a cost, not a
contribution.

## The four sections

Exactly these, in this order.

### Affected files

One line each: the path, and what changes about it. Enough that a reviewer can
tell whether the blast radius is what they expected.

A file that does not exist yet is marked **new file**:

```
- src/commands/health.ts — new file, the command
- src/cli.ts — route `crewbit health` to it
```

That wording is checked. "add the command" describes behaviour and does not
count, because it reads the same whether the file exists or not.

A plan touching more than roughly ten files is a plan that should be split. Say
so instead of listing them.

### Approach

Short. What you are doing and, where a real choice exists, why this one and not
the obvious alternative. Two paragraphs is generous.

This is the section a reviewer disagrees with, so make the disagreement possible:
"changing the existing poller rather than adding a second one, because two
pollers would double the API calls" invites a real objection. "Refactor for
maintainability" invites nothing.

### Steps

Ordered, and each one a change that leaves the tree working. A step nobody can
stop after is two steps.

### Tests & evals (write first)

The contract the code stage implements against. Each item is concrete enough to
turn into a failing test before any implementation exists:

```
- [unit] rejects a token whose expiry has passed
- [unit] a batch replayed after a reconnect leaves one row per event
- [integration] a Job dispatched with no runner connected returns 503
```

"Test the happy path" transfers no information. Name the input and the expected
outcome.

**Include the edge cases you found while exploring**, not only the ones the Spec
mentions. Empty input, the second call, the concurrent call, the failure of the
thing you depend on. This section is where a missing edge case is cheap to add
and where its absence becomes a bug.

## Two ways to refuse

Both are successful outcomes of planning, not failures of it.

**Too thin.** Exploring did not make the Spec plannable: there is no clear
problem, or no acceptance criteria you could turn into a test. Say which is
missing and what would satisfy it, the way the readiness rule describes, and
stop. Do not plan around the gap.

**Too big.** It cannot land as one focused change. Do not plan half of it.
Propose a split where each piece is independently valuable and separately
reviewable, and say what order they go in. A split into pieces that only make
sense merged together is not a split.

## What a plan never does

- Invent a requirement the Spec does not state. If the Spec is silent on
  something you need, that is a reason to refuse, not to decide.
- Change scope. Adding "while we are here, also..." is how a focused change
  becomes an unreviewable one.
- Include code. Name what changes; the code stage writes it.
