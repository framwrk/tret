# Rewrite contracts (Phase 2)

This document freezes the interfaces the rest of the install-recording rewrite is written against.
Phase 2 is **types, stubs, and tests only**: it defines the seams and proves the existing macOS
behavior is preserved behind them. It does not implement capture, storage, or uninstall, and it does
not change runtime behavior. The files here are consumed by later phases; the running `install`,
`uninstall`, `list`, and `find` commands still use the pre-rewrite code paths.

The decisions referenced below (`D1`–`D10`) live in the Decisions log of `REWRITE_PLAN.md`.

## Where each contract lives

| Contract                                       | Module                             | Implementing phase                           |
| ---------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `Platform` + macOS/Linux tables                | `src/lib/platform/`                | 2 (this phase); wired into commands in 5/7/9 |
| `CaptureBackend`, journal events, fake backend | `src/lib/capture/`                 | 4                                            |
| Normalized effects + `RecordV3`                | `src/types.ts`, `src/lib/journal/` | 3                                            |
| `Storage` (records + blobs)                    | `src/lib/storage.ts`               | 6                                            |
| `UninstallPlanner`                             | `src/lib/uninstall-planner.ts`     | 7                                            |

## `Platform` (`src/lib/platform/`)

`Platform` is the single seam for every OS-specific decision (plan section 8). Adding a platform
should be one table plus one capture backend, not edits scattered across commands.

| Field                             | Purpose                                                                                               | Replaces                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `scopeRoots`                      | Absolute roots outside `$HOME` included in a scoped capture/snapshot                                  | `SNAPSHOT_ROOTS`                     |
| `searchRootsInHome`               | Home-relative tool directories searched by `tret find`                                                | `SEARCH_DIRS_IN_HOME`                |
| `captureRootsInHome`              | Home-relative install surfaces a scoped capture observes (curated, narrower than the search roots)    | new in the D3 revision (defect #2)   |
| `searchRootsAbsolute`             | Absolute directories searched by `tret find`                                                          | `SNAPSHOT_ROOTS`                     |
| `sharedAbsolute` / `sharedInHome` | Directories uninstall refuses to delete whole                                                         | `SHARED_ABSOLUTE` / `SHARED_IN_HOME` |
| `shellConfigs`                    | Per-shell config files (or directories) uninstall cleans                                              | `RC_FILES`                           |
| `privilege`                       | Whether root installs are supported; default privilege; sudo-aware uninstall; never escalate silently | implicit per-OS behavior (D8)        |
| `artifacts`                       | Archive naming for the `os`/`arch` matrix, checksum manifest, hashing command                         | hardcoded `tret-macos-arm64` (D9)    |
| `case`                            | Default filesystem case sensitivity and a per-mount probe stub                                        | implicit macOS assumption (D10)      |

`MACOS_PLATFORM` reproduces the pre-rewrite macOS tables exactly, and `platformFor`/`currentPlatform`
in `src/lib/platform/index.ts` resolve a table by OS id. The existing macOS-only modules
(`snapshot.ts`, `related.ts`, `removal.ts`, `shellconfig.ts`) now read from `MACOS_PLATFORM`, so the
values have exactly one definition while runtime behavior stays identical on every OS. The Linux
table is a first-class table with XDG, systemd, desktop-entry, and package-manager surfaces; it is
not wired into commands yet.

**No Homebrew scope is added.** The two `/opt/homebrew` roots that already existed on macOS
(`/opt/homebrew`, `/opt/homebrew/bin`) are preserved only to keep behavior equivalent; nothing new
was added, and the Linux table contains no Homebrew paths.

## `CaptureBackend` (`src/lib/capture/`)

`CaptureBackend` turns an install process tree's filesystem activity into a `Journal`. Record
processing and uninstall depend on this interface, never on a particular OS mechanism, so a Linux
tracer and the labeled macOS heuristic fallback produce the same shape (D1, D7).

- `CaptureBackend.start(options) -> CaptureSession`; `CaptureSession.stop() -> Journal`.
- `CaptureStartOptions` carries the installer `pid`, the install `privilege`, and the absolute
  `roots` to observe.
- `FakeCaptureBackend` (in `fake.ts`) is an in-memory backend for tests: queue events with `push()`,
  then `start`/`stop` to collect a journal. It records every `start()` call for assertions.

The Phase 4 macOS implementation (`MacosHeuristicCaptureBackend`, `src/lib/capture/macos/`) implements
this interface as a labeled heuristic fallback; see `docs/rewrite/macos-capture.md` for its scope,
hashing policy, and coverage limits.

### Journal events (`src/lib/capture/events.ts`)

`JournalEvent` is the union of operations a backend can report, each carrying `seq`, `at`, the
attributing `pid` when known, and before/after metadata:

`create`, `write`, `rename`, `unlink`, `chmod`, `symlink`, `mkdir`, `rmdir`.

Metadata is `FileMetadata` (content hash, size, mode, mtime), `DirectoryMetadata`, or
`SymlinkMetadata` (target recorded, never followed). `JournalEventInput` is the same union minus
`seq`/`at`, which the journal assigns.

## Normalized effects and `RecordV3` (Phase 3)

`src/lib/capture/normalize.ts` freezes the types (`NormalizedEffects`, `NormalizationDiagnostic`,
`BackupPolicy`, `NormalizeInput`); Phase 3 implements the pure conversion as `normalizeJournal` in
`src/lib/journal/` (re-exported from `capture/normalize.ts`, so this contract path is unchanged).

`RecordV3` (in `src/types.ts`) is the plan section 3 shape with finalized names and the decided
fields:

- `id`, `name`, `source: "install" | "find"`, `url`, `installedAt`, `executable`, `scriptSha256`.
- `capture: { backend, completeness: "complete" | "partial" | "heuristic", segments }`; `segments`
  reserves bounded observation windows so a later explicit `tret trace` can append without a format
  migration (D5).
- `privilege: "user" | "root"` (D8) and `caseSensitive: boolean` (D10).
- `owned` (`OwnedEntry`: `kind`, optional symlink `linkTarget`, optional `installedHash`),
  `mutated` (`MutatedEntry`: before/after hashes, optional `beforeBlob`), and `deleted`
  (`DeletedEntry`: before hash, optional `beforeBlob`). `kind` is `"file" | "directory" |
"symlink"`, plus `"unknown"` reserved for migrated v2 records, which stored paths without a kind;
  a capture backend never emits `"unknown"`, and uninstall treats it as non-removable.
- optional `managedBy` (`ManagedPackage`: `manager`, `package`, optional `globalRoot`) marks an
  executable installed through a package manager's global mode. Its shared `node_modules`, lockfile,
  and manifest stay out of `owned`; uninstall delegates the package to the manager first
  (`bun remove -g`, `npm uninstall -g --prefix <prefix>`) and only then removes the remaining paths,
  so a failed package removal leaves the record and its files untouched for a retry. `globalRoot` is
  the shared root the package lives under (the directory containing the shared `node_modules`) when
  it is not the manager's fixed home-relative default; npm records it because its prefix varies per
  machine, while bun's fixed `.bun/install/global` needs no override.
- optional `managedInstall` (`ManagedInstall`: `kind`, `layout`, `root`) marks a tool installed
  through its own first-party managed layout, recognized by a marker file under `root`
  (`managed-install.json` with `kind: pi-managed-install`, `schemaVersion: 1`, `layout: releases-v1`).
  The whole root subtree — the marker, the versioned releases, and the `node_modules` payload capture
  skips everywhere — stays out of `owned`; the launcher and PATH entrypoint outside the root do not.
  Detection resolves a PATH entrypoint symlink to the launcher under `<agent>/bin` and takes the
  sibling `<agent>/install` as the root, mirroring the installer's own uninstaller. Uninstall
  re-verifies the marker and delegates a recursive removal of the root (`rm -rf`) **before** removing
  the remaining paths, and only drops the record once that removal proves the root gone; an invalid
  marker or a failed removal keeps the record. npm's shared `~/.npm` state is excluded from capture
  like bun's shared global root, so an installer's `npm ci` churn is never attributed to the tool.

`RecordFileV3` wraps `RecordV3[]` with `version: 3`. Multiple records may claim one path; conflicts
are resolved by uninstall planning, never by silently transferring ownership (D4).

## `Storage` (`src/lib/storage.ts`)

`Storage` loads and persists v3 records plus their content-addressed before-image blobs. The real
filesystem-backed implementation (atomic writes, restrictive permissions, size limits, v2→v3
migration) lands in Phase 6.

- `loadRecords()` / `saveRecord(record)` / `removeRecord(id)`.
- `putBlob(bytes) -> BlobRef`, `getBlob(id)`, `gc(keep) -> BlobId[]` (content-addressed; GC removes
  only unreferenced blobs, D2).
- `referencedBlobs(records)` collects the before-image addresses every record references, the `keep`
  input to `gc`.

With backups enabled, the install integration reads pre-existing file contents at the capture
window's start (`Journal.beforeImages`, keyed by content address), stores them with
`captureBeforeImage`/`putBlob`, and records each resulting address as `MutatedEntry.beforeBlob` or
`DeletedEntry.beforeBlob`. `normalizeJournal` only claims a before-image for a hash listed in
`NormalizeInput.availableBeforeImages`, so a record never points at a blob storage does not hold.

## `UninstallPlanner` (`src/lib/uninstall-planner.ts`)

`plan(record, context?) -> Promise<UninstallPlan>` is a conservative, side-effect-free plan
(plan section 6). `UninstallAction` is a five-way union: `remove`, `restore`, `skip`, `detected`,
or `conflict`. `detected` is a non-restorable change (no `beforeBlob`), reported for honesty and
never blocking; only `conflict` is actionable. The plan records `requiresSudo` (D8) and
`incomplete` (an actionable conflict blocks a clean uninstall). The
context can carry other records that claim the same paths (D4 shared ownership), a `force` flag, an
`inspect` callback for current state, and `delegatedRoots` — managed-install roots whose whole
subtree a recursive removal will clear (see `managedInstall` above). The planner treats each
delegated root as already gone, so an owned ancestor directory that only held the root is still
planned for removal instead of being reported `not-empty` against payload the record never owns.
Applying the plan is Phase 7; a dry run and the real
uninstall share the same plan so they cannot diverge.

## Tests

Each contract has a test that compiles it and checks its shape:

- `src/lib/platform/platform.test.ts` — macOS tables match the copied pre-rewrite literals exactly,
  Linux surfaces, artifact naming, privilege policy, and case defaults.
- `src/lib/capture/capture.test.ts` — the event union covers every operation; the fake backend
  replays events in order with assigned sequence numbers and coverage metadata.
- `src/types.test.ts` — the `RecordV3` shape (owned/mutated/deleted, capture, privilege, case).
- `src/lib/storage.test.ts` — an in-memory `Storage` round-trips records and blobs, deduplicates by
  content, garbage-collects unreferenced blobs, and exposes `referencedBlobs`.
- `src/lib/uninstall-planner.test.ts` — a stub planner emits remove/restore/skip/conflict and the
  action union discriminates correctly.
