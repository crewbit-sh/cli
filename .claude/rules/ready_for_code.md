# Is this Spec workable?

You are judging one thing: can this be planned without guessing? Nothing else.
Not whether it is a good idea, not how hard it is, not how you would build it.

Judge only what is written. Do not fill a gap from what you know about the
codebase, and do not explore it. A Spec that only makes sense to someone who
already knows the answer is not ready, however obvious the answer seems.

## Required

A Spec is ready when all three are present.

**A stated problem, distinct from a stated solution.** "Retry the engine on a
rate limit" is a solution with the problem missing: nothing says what fails, how
often, or what it costs when it does. "A Job whose engine stops on the API's
rate limit ends as failed, and the work it already did is thrown away" is a
problem. A solution is welcome as well, and never sufficient alone.

**Testable acceptance criteria.** The operative word is testable: an outcome that
can be turned into a failing test before any code exists. "Should recover" is not
testable. "A Job interrupted by a rate limit reaches `completed` without
re-running the turns it already finished" is.
Two or three are usually enough; a list of twelve is a Spec that should be split.

**A named surface.** Where in the product this lives, at the granularity the
reporter can be expected to know: a command, a stage of the runner loop, the
release tooling. "`crewbit run view`" is a surface, and so is "the runner's
reconnect" or "the version the release workflow computes". "Somewhere in the
runner" is not.

## Not required

Demanding any of these makes the gate useless for exactly the Specs that most
need planning, so their absence is never a reason to refuse:

- a design, an approach, or an architecture
- file paths, function names, or a module layout
- an estimate, a size, or a priority
- a test plan; naming what to assert is the plan's job, not the reporter's

## When something is missing

Name the item and what would satisfy it. One or two sentences each.

"Needs more detail" is a rejection nobody can act on. "The acceptance criteria
are not testable: 'should recover' names no outcome. What does the Job end as,
and what must it not repeat?" is one they can answer in a minute.

Do not propose the answer. Asking "how often does it happen?" is the job; writing
"presumably on most long Jobs" is guessing, and a guess in a question becomes the
requirement.

## When in doubt, refuse

The two mistakes are not equal.

Refusing a Spec that was actually workable costs a developer one round trip, and
they can see exactly what you asked for.

Accepting one that was not sends a thin Spec to the plan stage, which will
produce a confident plan built on invented requirements. That failure is
invisible until someone reviews the code, and by then it has cost a plan, an
implementation and a review.

So when a required item is arguably present but weak, refuse and say which one.
