# Linux x64 release verification

This is the durable record of the Linux x64 verification run for the Linux validation fixes, and the
operator guide for repeating the host-dependent checks before a release. It separates what was
actually run from what still needs an approved host. See the [release checklist](release-checklist.md)
for the complete release gate.

**Recorded:** 2026-10-31 against `main` at `911fe3a` after all Part 2 PRs merged, including the
fanotify helper fixes #44/#45 and the final reconciliation #46. This record describes the Linux x64
path only. The [final main CI run
41222352681](https://github.com/framwrk/tret/actions/runs/41222352681) passed on all four targets.

## Published release

**v0.6.0** was tagged from `main` at `68c7d01` and published by the [release
workflow](https://github.com/framwrk/tret/actions/runs/41241462965). The workflow built all four
targets plus both `tret-fanotify` helpers, verified the merged assets and checksums, and attached
them to [v0.6.0](https://github.com/framwrk/tret/releases/tag/v0.6.0) as a pre-release. V4 remains an
explicitly reviewed skip for this release.

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

| Check                                                         | Status          | Summary                                                                                                                                           |
| ------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 source checks                                              | Passed          | `lint` and `typecheck` pass; `bun test` is 573 pass, 1 skip, 0 fail.                                                                              |
| V2 build, install script, release verification                | Passed          | All four targets built; `tret-linux-x64` install test and the four-target release verification pass.                                              |
| V6 package-manager, managed-install, delegated-removal suites | Passed          | Ran as part of `bun test`; focused rerun is 40 pass, 0 fail.                                                                                      |
| V3 sandboxed acceptance matrix                                | Passed          | `scripts/linux-acceptance.ts` passed 10/10 scenarios with 0 skips locally and in the `linux-x64` CI job.                                          |
| V4 production `linux-strace`                                  | Skipped/blocked | Not run; an explicitly reviewed skip for this release. Needs an approved host with `ptrace_scope=0`; this host is `1`. Never automated.           |
| V5 privileged root strace/fanotify                            | Passed (CI)     | Final CI `linux-x64` selected `linux-strace` (complete) and `linux-fanotify` (partial); backend selection is proven, attribution accuracy is not. |
| V7 cross-target CI                                            | Passed          | The main CI run passed `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.                                                              |
| V8 real `$HOME` and `/etc/profile.d` integrity                | Passed          | The acceptance harness reported 20 host paths unchanged locally; CI also runs the strict acceptance step.                                         |

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

**Passed.** The sandboxed harness at [scripts/linux-acceptance.ts](../scripts/linux-acceptance.ts)
drives the built `tret-linux-x64` artifact through the ten Linux findings with a temporary `HOME` and
loopback-hosted local installers. It also snapshots the real `$HOME` and `/etc/profile.d` before and
after.

- Local run: **10/10 scenarios passed, 0 skips**.
- CI run: `linux-x64` runs the same harness with `TRET_ACCEPTANCE_STRICT=1`, so an environmental skip
  would fail the gate; the [final main CI
  run](https://github.com/framwrk/tret/actions/runs/41222352681) passed with 10/10 and 0 skips.
- V8 host integrity: **20 paths unchanged**, covering the real `$HOME` configs,
  `~/.tret/records.json`, and `/etc/profile.d` files and directory.

The harness only reads the real user state; every artifact run uses a throwaway `HOME`. CI also runs
the strict acceptance step on the `linux-x64` target.

## V4: production `linux-strace` on an approved host

**Skipped/blocked: not run.** This host has `kernel.yama.ptrace_scope=1`, and no explicitly approved
disposable host was used, so the real production `linux-strace` attach has not been exercised. The
stock behavior here is the labeled `linux-heuristic` fallback, which is covered by the test suite; it
is not a real `linux-strace` production attach.

The gated check at [scripts/linux-strace-e2e.ts](../scripts/linux-strace-e2e.ts) refuses to pass
without the prerequisites: Linux, a non-root user, `strace` on `PATH`, and `ptrace_scope=0`. It never
changes a sysctl and never escalates. To run it:

1. Use an explicitly approved disposable Linux host. Record the current value of
   `kernel.yama.ptrace_scope` and set it to `0` temporarily, with a trap that restores the original
   value even on failure.
2. Run `bun scripts/linux-strace-e2e.ts`, or set `TRET_REQUIRE_STRACE=1` to turn a missing
   prerequisite into a failure.
3. Assert from `tret inspect --json` that `capture.backend` is `linux-strace` with the expected
   completeness, and that the traced tool ran exactly once.
4. Confirm the original `ptrace_scope` value is restored.

Never automate the sysctl change in tests or CI, and never change it on a host without explicit
approval.

### Release readiness

For the next release this is an **explicitly reviewed skip**: no approved disposable host with
`ptrace_scope=0` was available, so the production `linux-strace` path is not exercised. The
[release checklist](release-checklist.md) permits a reviewed skip here. V4 has not passed, and this
record does not claim otherwise.

[scripts/linux-strace-e2e.ts](../scripts/linux-strace-e2e.ts) remains a hard requirement before any
future release claims a production `linux-strace` run: that claim needs a recorded result from an
approved disposable host with the original `ptrace_scope` restored.

## V5: privileged root strace and fanotify

**Passed in CI on `linux-x64`.** The workstation run is skipped because `sudo -n true` fails with
`interactive authentication is required`, so the recorded result is the final CI run. The [main CI
run 41222352681](https://github.com/framwrk/tret/actions/runs/41222352681) includes the privileged
step and runs [scripts/privileged-e2e.sh](../scripts/privileged-e2e.sh) explicitly against both
backends:

- Root strace: `capture.backend: linux-strace`, completeness `complete`.
- Fanotify: `capture.backend: linux-fanotify`, completeness `partial`, using the packaged helper
  staged beside a copy of the binary.

The earlier record cited run 41221754679, which predates #44/#45. Those PRs fixed the fanotify helper
attach and root-fd failures that the earlier run exposed: the helper now marks with
`FAN_MARK_FILESYSTEM`, reports `FAN_REPORT_DFID_NAME`, and opens observe roots read-only instead of
`O_PATH`, so privileged fanotify runs no longer produce zero events over every root. The final run
above is the authoritative result.

This proves the intended backend was selected for each privileged flow. It does **not** prove
fanotify attribution accuracy: the shipped helper still has the documented F1–F4 fidelity gaps, so a
completed fanotify run is not proof that its directory-entry records are correct. See [Linux capture
fidelity](capture/linux-fidelity.md) and [Linux capture](capture/linux-capture.md).

## V7: cross-target CI

**Passed.** The [final main CI run
41222352681](https://github.com/framwrk/tret/actions/runs/41222352681) passed on all four targets:
`darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. Each target builds and passes `bun run
lint`, `bun run typecheck`, `bun test`, and `scripts/install.test.sh`. The `linux-x64` job also runs
the strict acceptance harness and the privileged backend checks above.

## Known skips and environment gates

| Skip or gate                                                              | Condition and reason                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace command (macOS heuristic capture)` in `src/commands/trace.test.ts` | Skipped unless `process.platform === "darwin"`. This is the single skip in the recorded Linux run.                                                                                                                                                                                                                                                                                                                              |
| `linux real-strace smoke` in `src/lib/capture/linux/linux.smoke.test.ts`  | Skipped unless the host is Linux and `strace` is on `PATH`. It ran on this host; a host without `strace` skips it.                                                                                                                                                                                                                                                                                                              |
| Root-sensitive permission tests                                           | `install.test.ts` (`--force reports a failed shell cleanup as failed and keeps the affected record entry`), `macos.test.ts` (`a permission-denied subdirectory is pruned quietly, but an unreadable root is reported`), and `shellconfig.test.ts` (`a failed snippet write reports failed and never cleaned`) are skipped when the suite runs as root, because root can read or write the files the assertions require to fail. |
| V4 production strace                                                      | Explicitly reviewed skip for this release. Requires an approved disposable host with `ptrace_scope=0`; the stock `ptrace_scope=1` fallback is `linux-heuristic`, not `linux-strace`. Not run, and never automated.                                                                                                                                                                                                              |
| Local V5 privileged run                                                   | Requires passwordless `sudo`; this workstation asks for a password. CI covers the privileged step on `linux-x64`, and that is the recorded result.                                                                                                                                                                                                                                                                              |
| Acceptance harness environmental skips                                    | The absolute `/etc/profile.d` variant needs `bwrap` and an existing `/etc/profile.d`; elsewhere it would skip. CI sets `TRET_ACCEPTANCE_STRICT=1` so a skip fails the gate. The recorded local and CI runs had 0 skips.                                                                                                                                                                                                         |

Host-specific skips belong in the release notes for that release, not in the permanent support
contract. See the [release checklist](release-checklist.md) before tagging.
