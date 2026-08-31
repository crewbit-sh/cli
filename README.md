# crewbit

The [Crewbit](https://crewbit.sh) runner. It connects to a Crewbit server,
executes one Job at a time with your own Claude Code, and reports back.

It holds no provider credential, has no awareness of an issue tracker, and
decides no state: everything it needs arrives inside the Job, and everything
it produces goes back as data for the server to decide about. What it speaks
to the server is [`@crewbit/protocol`](https://github.com/crewbit-sh/protocol).

## Install

Download the binary for your platform from
[Releases](https://github.com/crewbit-sh/cli/releases): `crewbit-macos-arm64`
or `crewbit-linux-x64`.

## Use

```
crewbit --token <token minted on your Crewbit credentials page> --slots 1
```

Run it again after upgrading; stopping it once finishes whatever Job it is
holding before it exits, and a second stop exits immediately.

## What changed between versions

[CHANGELOG.md](./CHANGELOG.md).

## Cutting a release

`.github/workflows/release.yml`, dispatched by hand from the Actions tab.
Its version comes from a bump computed over the commits since the last
`cli-v*` tag — `feat:` a minor, `fix:` a patch — written to `package.json`,
`CHANGELOG.md` and `RUNNER_VERSION` before anything is tagged or published.

That is the opposite contract from
[`crewbit-sh/protocol`](https://github.com/crewbit-sh/protocol), where
`CHANGELOG.md` is what a person edits and the workflow only checks that its
top heading is newer than what npm already has. Two repositories of the
same project reading differently on purpose: this changelog can be
generated because it is read by a developer who wants to know what changed
in the thing they run, and CLAUDE.md already draws that line in
crewbit-v2 — the runner's history may be mechanical, the service's and the
protocol's need a person's judgment about what a stranger should be told.
