# crewbit

What changed for the person who installs and runs this.

Upgrading is replacing the binary and starting it again. Stop the old one once
and it finishes what it is holding before it exits, so an upgrade costs you
nothing that was in flight. Stop it a second time and it exits straight away.

## 0.3.0

### Added

- the macOS binaries are signed and notarized
- the runner says when a newer one is out

### Fixed

- codesign --force, because darwin-x64 arrives already signed

## 0.2.0

### Added

- the runner is also built for Intel Macs

## 0.1.2

### Fixed

- the reconnect log counts the attempt it is reporting on

## 0.1.1

A fix for the most expensive thing that could go wrong: work that finished, and
was lost on the way back.

### Fixed

- Finished work is no longer thrown away when the connection fails at the last
  moment
- A push that fails says what git said, instead of only that it failed
- Work that reached the branch is no longer thrown away by a push that lost a race
- A connection that fails before it starts says what could be wrong instead of
  blaming your credential, and points at a page that exists
- The command the Runners page hands you is the one that exists: the binary is called crewbit
- The version it reports, both to `--version` and to Crewbit when it connects, is now the version that is actually running, instead of a placeholder stuck at 0.0.0 since the first release

## 0.1.0

First release. It connects to Crewbit, runs work with your own Claude Code, and
reports back.

### Added

- Reads an issue and writes a plan for you to approve before any code is written
- Runs the work in a fresh workspace, prepared before anything executes in it
- Writes code and delivers it to a branch, or tells you why it could not
- Runs your project's own verify command, so a change is checked the way you
  check it
- Reviews the change it produced against what was asked for
- Streams progress while work is running, so you can watch instead of waiting
- Survives a lost connection: it reconnects and finishes what it was doing,
  rather than starting over
- Keeps finished work even if the process is stopped or dies partway
- Stopping it finishes what it is holding instead of dropping it
- Cancelling stops the work for real, and work that cannot proceed is not
  retried forever
- Tells a rate limit apart from a crash, and a turn budget being reached apart
  from a failure
- Connects only with credentials you issued
- Logs what it is doing as structured lines, ready for any collector

### Fixed

- The credentials used to fetch your code are no longer reachable by the model
  writing it, and it cannot push anywhere on its own
- A failing git command now reports what git said, instead of only an exit code
- A failure now explains itself, and your approved plan is left where it was
- Work handed to a second machine continues rather than colliding with the first
- Losing the connection no longer causes an endless retry storm
- Work that no machine can run no longer blocks everything queued behind it
- The review reads the change being judged, and no longer reports newer work on
  the base branch as deleted
