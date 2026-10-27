# Plans index

**Last updated:** 2026-10-27

**Current status:** No active implementation plans. Every numbered step in the next-up ordering
plan is complete. The macOS attributed-capture step recorded a deferred, closed gate with no code
written.

The numbered-step status comes from the local planning record
`.agents/plans/next-up-ordering.md`. That directory is ignored by Git, so this index is the shipped
inventory; the links below point only at tracked documentation.

## Status key

- **Complete** — implemented or verified, and no longer active work.
- **Deferred** — a recorded decision not to pursue the work now; not active backlog.

## Shipped plans

| Plan                                                                            | Status                                  | Outcome                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [01 — Safety and data integrity](01-safety-and-data-integrity.md)               | **Complete** — merged in #11            | Fingerprint-checked removal, root boundaries, restore state, concurrency-safe records, and deep record validation.                           |
| [02 — Finish platform support and adoption](02-finish-platform-and-adoption.md) | **Complete** — shipped through `v0.3.3` | Platform abstraction, Linux shell/search behavior, packaged fanotify helper, real Linux coverage, backups, case probes, and `find` adoption. |
| [03 — Next user workflows](03-user-workflows.md)                                | **Complete** — merged in #17            | `inspect`, `trace`, tracked-tool `update`, explicit names/ids, `--json`, and installer consent.                                              |
| [04 — Release confidence and documentation](04-release-confidence.md)           | **Complete**                            | PR CI, type-checking, the platform matrix, end-to-end regression coverage, shipped-behavior tests, aligned docs, and the release checklist.  |

## Next-up ordering

| Step                                       | Status                                                           | Evidence                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Documentation truth pass + repo hygiene | **Complete** — 2026-10-26                                        | `docs/plans/03-user-workflows.md`, `docs/capture/plan.md` (D12), and the `install`/`trace` consent fixes, with lint, typecheck, and tests green.                                                                                                              |
| 2. Release v0.4.0                          | **Complete** — tag `v0.4.0` published 2026-10-22 as a prerelease | [Release checklist](../release-checklist.md) and the published release assets.                                                                                                                                                                                |
| 3. D8 privileged-install verification      | **Complete**                                                     | `scripts/privileged-e2e.sh` runs on `linux-x64` in CI and covers root-owned install, privilege detection, no automatic escalation, sudo re-run removal, and fanotify.                                                                                         |
| 4. Ownership-conflict resolution (D4)      | **Complete** — 2026-10-26                                        | `tret unclaim <tool> <path>`; [D4 decision](../capture/plan.md#d4-ownership-conflict-resolution); local plan `.agents/plans/05-ownership-conflict-resolution.md`.                                                                                             |
| 5. Linux capture fidelity spike            | **Complete** — 2026-10-26                                        | [Linux capture fidelity](../capture/linux-fidelity.md); decisions [D13](../capture/plan.md#d13-ebpf-tracepoint-backend), [D14](../capture/plan.md#d14-userns--overlayfs-backend), and [D15](../capture/plan.md#d15-linux-fidelity-gate-before-a-new-backend). |
| 6. macOS attributed capture                | **Complete** — deferred, gate closed, no code, 2026-10-27        | [D16 decision](../capture/plan.md#d16-macos-attributed-capture-gate) and [macOS capture limits](../capture/macos-capture.md). The only macOS backend remains `macos-heuristic`.                                                                               |
| 7. Plans index                             | **Complete** — 2026-10-27                                        | This file.                                                                                                                                                                                                                                                    |

## Active backlog

None. The deferred macOS item is a closed decision, not pending work. The Linux fidelity follow-ups
recorded in [linux-fidelity.md](../capture/linux-fidelity.md) need their own plans before any work
starts, and none is active.
