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
