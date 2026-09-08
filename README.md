# crewbit

The [Crewbit](https://crewbit.sh) runner. It connects to a Crewbit server,
executes one Job at a time with your own Claude Code, and reports back.

It holds no provider credential, has no awareness of an issue tracker, and
decides no state: everything it needs arrives inside the Job, and everything
it produces goes back as data for the server to decide about. What it speaks
to the server is [`@crewbit/protocol`](https://github.com/crewbit-sh/protocol).

## Install

Download the binary for your platform from the
[latest release](https://github.com/crewbit-sh/cli/releases/latest):
`crewbit-macos-arm64` (Apple Silicon), `crewbit-macos-x64` (Intel), or
`crewbit-linux-x64`.

## Use

```
crewbit runner --token <token minted on your Crewbit credentials page> --slots 1
```

Run it again after upgrading; stopping it once finishes whatever Job it is
holding before it exits, and a second stop exits immediately.

## Investigate a Run

```
crewbit run view <id> --token <the same runner token>
```

Prints the Run's state, how long it has been there, its transitions and how
many events its Jobs reported, without opening a browser. Events are counted
but not fetched by default; `--events <n>` asks for that many. `--output json`
prints the server's own response instead.

## Drive a Run

Every command takes the same `--token`, `--server` and `--output json` as
`run view`, and each is one request to the server that owns the Run.

| Command | What it does |
| --- | --- |
| `crewbit spec list --project <id>` | the Specs a Project's sources are offering |
| `crewbit spec plan <ref>` | start planning one, as `acme/api#12` |
| `crewbit spec run <ref>` | the fast path: start one running |
| `crewbit run list` | the org's live Runs, most recently updated first |
| `crewbit run view <id>` | read one Run for investigation |
| `crewbit run approve <id>` | answer the plan gate: the code stage runs next |
| `crewbit run reject <id>` | send it back, with `--reason` |
| `crewbit run replan <id>` | plan again from the Spec as it is now |
| `crewbit run answer <id>` | answer the question a stage asked, with `--data` or `--file` |
| `crewbit run cancel <id>` | end the Run now, whatever it was in the middle of |
| `crewbit run judge <id>` | judge the review as it stands |
| `crewbit run now <id>` | take the Run's next step without waiting to be scheduled |
| `crewbit project list` | the Projects this credential's org owns |
| `crewbit project view <id>` | one Project, its sources and what each answers for |

An answer is a JSON object, and `crewbit run answer` says so before it sends
anything:

```
crewbit run answer run_abc --data '{"choice":"the second one"}'
crewbit run answer run_abc --file answer.json
```

## What changed between versions

[CHANGELOG.md](./CHANGELOG.md).

## Cutting a release

`.github/workflows/release.yml`, dispatched by hand from the Actions tab.
Its version comes from a bump computed over the commits since the last
`v*` tag — `feat:` a minor, `fix:` a patch — written to `package.json`,
`CHANGELOG.md` and `RUNNER_VERSION` before anything is tagged or published.

That is the opposite contract from
[`crewbit-sh/protocol`](https://github.com/crewbit-sh/protocol), where
`CHANGELOG.md` is what a person edits and the workflow only checks that its
top heading is newer than what npm already has. Two repositories of the
same project reading differently on purpose: this changelog can be
generated because it is read by a developer who wants to know what changed
in the thing they run, and CLAUDE.md already draws that line for
the project: the runner's history may be mechanical, the service's and the
protocol's need a person's judgment about what a stranger should be told.
