# Linux x64 release verification

This is the durable record of the Linux x64 verification run for the Linux validation fixes, and the
operator guide for repeating the host-dependent checks before a release. It separates what was
actually run from what still needs an approved host or a merged CI run. See the
[release checklist](release-checklist.md) for the complete release gate.

**Recorded:** 2026-10-31 against `main` at `09d0343` (Part 1 merged). Part 2 changes are on feature
branches; this record describes the Linux x64 path only.

## Host

| Item                            | Value                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| OS                              | Ubuntu 26.04.1 LTS (Resolute Raccoon), x86_64                                   |
| Kernel                          | 7.0.0-42-generic                                                                |
| `strace`                        | 6.19                                                                            |
| Yama `kernel.yama.ptrace_scope` | `1`                                                                             |
| Passwordless `sudo`             | Not available (`sudo -n true` reports `interactive authentication is required`) |
| Bun                             | 1.4.4                                                                           |

## Status at a glance

| Check                                                         | Status          | Summary                                                                                              |
| ------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| V1 source checks                                              | Passed          | `lint` and `typecheck` pass; `bun test` is 573 pass, 1 skip, 0 fail.                                 |
| V2 build, install script, release verification                | Passed          | All four targets built; `tret-linux-x64` install test and the four-target release verification pass. |
| V6 package-manager, managed-install, delegated-removal suites | Passed          | Ran as part of `bun test`; focused rerun is 40 pass, 0 fail.                                         |
| V3 sandboxed acceptance matrix                                | Pending         | `scripts/linux-acceptance.ts` is not on this branch; no result is claimed.                           |
| V4 production `linux-strace`                                  | Skipped here    | Needs an approved host with `ptrace_scope=0`; this host is `1`. Never automated.                     |
| V5 privileged root strace/fanotify                            | Skipped locally | Needs passwordless `sudo`; CI runs it on `linux-x64`.                                                |
| V7 cross-target CI                                            | Pending         | Required after the Part 2 PRs merge; no green run is claimed.                                        |
| V8 real `$HOME` and `/etc/profile.d` integrity                | Pending         | Measured by the acceptance harness; not available on this branch.                                    |

## V1: source checks

Run from the repository root with Bun on `PATH`:

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
```

Results on this host:

- `bun run lint` — passed, no findings.
- `bun run typecheck` (`tsc --noEmit`) — passed, no errors.
- `bun test` — **573 pass, 1 skip, 0 fail**, 1925 `expect()` calls, 574 tests across 51 files.

The single skip is the macOS-only `trace command (macOS heuristic capture)` group in
`src/commands/trace.test.ts` (`describe.skipIf(process.platform !== "darwin")`). The real-strace smoke
suite in `src/lib/capture/linux/linux.smoke.test.ts` is also environment-gated on `strace` being
present; because this host has `strace 6.19`, it ran and passed. On a host without `strace`, that
suite is skipped instead and remains the environment-gated skip to record.

## V2: build, install script, release verification

Run from the repository root after V1:

```sh
bash scripts/build.sh
bash scripts/install.test.sh
bash scripts/verify-release.sh dist
```

Results on this host:

- `bash scripts/build.sh` — built `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`, and
  compiled `tret-fanotify` for both Linux targets. The script wrote `dist/checksums.txt`.
- `bash scripts/install.test.sh` — `install.test.sh: OK for tret-linux-x64`. The test uses a temporary
  home and a local `curl` shim, so it does not touch the network or the real user home.
- `bash scripts/verify-release.sh dist` — `verify-release.sh: OK - all 4 targets and their checksums
verified in dist`. It checks every published asset, the checksum manifest in both directions,
  checksum contents, and the archive members `scripts/install.sh` extracts.

## V6: package-manager, managed-install, delegated-removal suites

These suites are part of `bun test` and passed in the full run above. A focused rerun with:

```sh
bun test src/lib/package-manager.test.ts src/lib/managed-install.test.ts \
  src/lib/delegated-removal.test.ts
```

reports **40 pass, 0 fail** across the three files. The relevant command-level coverage is also in
the same full run:

- `src/commands/uninstall.test.ts` — `a managed global package is removed through its package
manager`, `blocks package-manager removal when another record claims a descendant, even with
--force`, `dry-run reports a delegated-removal conflict and exits non-zero`, `allows package-manager
removal when another record claims a sibling package`, and `removes a managed install recognized
from its executable when the record predates the field`.
- `src/commands/install.test.ts` — `recognizes a pi managed install, never owns the payload, and
delegates its removal`, `--force reinstalls a managed install by clearing the previous root first`,
  and `a delegated removal that cannot clear the root keeps the record for a retry`.

No real global package installation is performed; the suites use recorded shims, temporary prefixes,
and fake runners.

## V3 and V8: sandboxed acceptance harness

**Pending.** The sandboxed acceptance harness at `scripts/linux-acceptance.ts` runs the original
Ubuntu 26.04 scenarios against the built binary with a temporary `HOME` and loopback-hosted local
installers. It also snapshots the real `$HOME` and `/etc/profile.d` before and after, and fails if
either changes. The harness is landing in a parallel Part 2 PR and is not present on this branch, so
this record does not claim V3 or V8 passed.

Required before release:

1. Run the harness against the built `tret-linux-x64` artifact on a Linux host.
2. Attach the scenario results and the before/after `$HOME` and `/etc/profile.d` checksums to the
   release PR; both checksums must match.
3. If the harness is unavailable, record an explicit, reviewed skip in the release notes rather than
   treating the matrix as passed.

V8 specifically depends on this harness: the checks in V1, V2, and V6 use temporary directories, but
they do not measure host-state checksums.

## V4: production `linux-strace` on an approved host

**Skipped locally.** This host has `kernel.yama.ptrace_scope=1`, so an unprivileged tracer cannot
attach to its parent. The shipped behavior is the labeled `linux-heuristic` fallback, which is
covered by the test suite; it is not a real `linux-strace` production attach.

The production-strace check requires an explicitly approved disposable Linux host:

1. Record the current value of `kernel.yama.ptrace_scope` and set it to `0` temporarily, with a trap
   that restores the original value even on failure.
2. Run real install and trace windows, for example `tret install <release-url> --yes` and
   `tret trace <tool> --yes`.
3. Assert from `tret inspect --json` that `capture.backend` is `linux-strace` and that completeness is
   the expected value for the run.
4. Confirm the original `ptrace_scope` value is restored.

Never automate the sysctl change in tests or CI, and never change it on a host without explicit
approval.

## V5: privileged root strace and fanotify

**Skipped locally; required in CI.** The check needs passwordless `sudo`. On this host
`sudo -n true` fails with `interactive authentication is required`, so no privileged run was made.
CI runs `bash scripts/privileged-e2e.sh` on the `linux-x64` target, where the runner has passwordless
sudo.

The privileged script covers a root-owned install, the root privilege recorded in the record, the
non-root dry-run requiring sudo, and the root uninstall. To verify the capture backend, not just flow
success:

1. Run it once with the fanotify helper explicitly selected (`TRET_FANOTIFY`, or by staging the
   helper under its adjacent `tret-fanotify` name) and once without it, so root strace is selected.
2. Read the actual backend from `tret inspect --json` (`capture.backend`) or the run log and record
   which backend ran for each run.
3. Keep the documented fanotify fidelity limits visible; a completed privileged flow is not proof of
   correct directory-entry attribution. See [Linux capture fidelity](capture/linux-fidelity.md) and
   [Linux capture](capture/linux-capture.md).

## V7: cross-target CI

**Pending.** The full suite and release build must run on `linux-x64`, `linux-arm64`, `darwin-x64`,
and `darwin-arm64` after the Part 2 PRs merge. This branch has not produced that CI run, and no green
cross-target result is claimed here. Record the CI link and any host-specific skips in the release
PR.

## Known skips and environment gates

| Skip or gate                                                              | Condition and reason                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace command (macOS heuristic capture)` in `src/commands/trace.test.ts` | Skipped unless `process.platform === "darwin"`. This is the single skip in the recorded Linux run.                                                                                                                                                                                                                                                                                                                              |
| `linux real-strace smoke` in `src/lib/capture/linux/linux.smoke.test.ts`  | Skipped unless the host is Linux and `strace` is on `PATH`. It ran on this host; a host without `strace` skips it.                                                                                                                                                                                                                                                                                                              |
| Root-sensitive permission tests                                           | `install.test.ts` (`--force reports a failed shell cleanup as failed and keeps the affected record entry`), `macos.test.ts` (`a permission-denied subdirectory is pruned quietly, but an unreadable root is reported`), and `shellconfig.test.ts` (`a failed snippet write reports failed and never cleaned`) are skipped when the suite runs as root, because root can read or write the files the assertions require to fail. |
| V4 production strace                                                      | Requires an approved disposable host with `ptrace_scope=0`; the stock `ptrace_scope=1` fallback is `linux-heuristic`, not `linux-strace`. Never automated.                                                                                                                                                                                                                                                                      |
| V5 privileged flow                                                        | Requires passwordless `sudo`; `scripts/privileged-e2e.sh` skips with exit 0 when it is not available. CI runs it on `linux-x64` only.                                                                                                                                                                                                                                                                                           |
| Acceptance harness and host checksums                                     | `scripts/linux-acceptance.ts` is not on this branch; V3 and V8 remain pending until it lands and runs.                                                                                                                                                                                                                                                                                                                          |

Host-specific skips belong in the release notes for that release, not in the permanent support
contract. See the [release checklist](release-checklist.md) before tagging.
