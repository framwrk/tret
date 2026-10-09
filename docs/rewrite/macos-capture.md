# macOS capture backend (Phase 4)

This document records the macOS capture backend shipped in Phase 4 and the coverage limits it
labels. It is the implementation of decision **D1** in the `REWRITE_PLAN.md` Decisions log: no
unprivileged macOS mechanism attributes filesystem changes to a process tree, so macOS ships the
**labeled heuristic fallback** (`capture.backend: "macos-heuristic"`,
`capture.completeness: "heuristic"`) behind the same `CaptureBackend` interface a tracer would use.

Nothing here requires root, an Apple-granted entitlement, SIP changes, or code injection.

## Why not a tracer

Phase 1's "macOS capture feasibility" table in `REWRITE_PLAN.md` evaluated every candidate. The
short version, with the limit that disqualifies each as a general backend:

| Mechanism                      | Limit                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| EndpointSecurity               | Needs an Apple-granted `com.apple.developer.endpoint-security.client` entitlement **and** root **and** TCC approval; cannot self-entitle. |
| DTrace / `fs_usage` / `dtruss` | Needs root, and tracing protected binaries needs SIP relaxed from Recovery.                                                               |
| FSEvents                       | Detect changes with **no PID**, so installer churn cannot be separated from background churn; coalescing and full rescans on drops.       |
| DYLD injection                 | Silently defeated by SIP, hardened runtime, setuid/setgid, scripts, and static binaries.                                                  |
| `sandbox-exec`                 | Deprecated enforcement, not observation; reports only denied operations.                                                                  |
| APFS snapshots                 | Privileged/entitled and is itself a global before/after diff — the heuristic this rewrite is escaping.                                    |

An opt-in tracer can be added later without a format migration: it implements `CaptureBackend`,
returns a `Journal` with `completeness: "complete"` (or `"partial"` with a `partialReason`), and its
`name` lands in `record.capture.backend`. Records stay distinguishable in `tret list` and uninstall
output because completeness is stored per record.

## How the fallback works

`MacosHeuristicCaptureBackend` (`src/lib/capture/macos/backend.ts`) implements the frozen
`CaptureBackend`:

- `start(options)` snapshots the bounded roots in `options.roots` (or the backend's configured
  roots) and returns a session.
- `stop()` re-scans the roots, hashes files whose stamps changed, diffs the two snapshots into
  journal events, assigns `seq`/`at`, and returns a `Journal` with
  `backend: "macos-heuristic"`, `completeness: "heuristic"`, and no `pid` on any event.
- If a root cannot be read or a file cannot be hashed, `partialReason` says so; completeness stays
  `"heuristic"` because attribution was never process-level to begin with.

The engine (`scoped.ts`) is deliberately small: it is `lstat`/`readdir` without following symlinks,
stamp comparison, and a pure snapshot→events diff. `scope.ts` expands the platform table into
bounded roots.

### Scope (D3)

`macosHeuristicRoots()` derives roots from the platform table rather than a hand-maintained list:

- `scopeRoots` — absolute roots outside `$HOME` (`/opt/homebrew/bin`, `/usr/local/bin` on macOS);
- `captureRootsInHome` — the tool dot-directories an installer targets: `.config`,
  `.local/{bin,lib,share,state}`, `Library/LaunchAgents`, and `Library/Application Support`;
- home shell config files (`shellConfigs`).

Capture roots are curated **separately** from `tret find`'s `searchRootsInHome`. Those search roots
stay broad (they include `~/Library` subtrees) so `find` can adopt a tool's files by hand; capture
observes only install surfaces. The pre-rewrite snapshot skipped `~/Library` entirely via
`EXCLUDED_PATHS`, but the first rewrite reused the whole search list for capture, which let background
churn inside `~/Library` be attributed to the installer. D3 is revisited here with that real installer
evidence:

- **Dropped as pure churn** (no installer target, continuously rewritten by background daemons):
  `.cache`, `Library/Caches`, `Library/Containers`, `Library/HTTPStorages`, `Library/Logs`,
  `Library/Saved Application State`, `Library/WebKit`.
- **Dropped `Library/Preferences`:** `cfprefsd` rewrites `*.plist` continuously and no filename rule
  separates that churn from a real install write. `tret find` still searches it for manual adoption.
- **Kept `Library/Application Support`** (it holds real tool state) behind a volatility skip: while
  scanning, `isVolatileChurnPath` (`src/lib/capture/macos/scope.ts`) skips known churn shapes — SQLite
  `*.db-wal`/`*.db-shm`/`sqlite-wal`/`sqlite-shm`, any `*-journal`, and LevelDB `*.log` under
  `IndexedDB` — so a background database never reads as an install mutation.

Callers may add or drop roots with `include`/`exclude`. The skip is a small shape-based rule, not a
per-app exclusion list: cache-shaped _roots_ are dropped by `installObservationRoots`, and the
remaining volatile _files_ are matched structurally. Outside these rules the platform table is the
bound, and the result stays labeled heuristic.

### Hashing policy

Content is hashed **only when a stamp changes**: files that are new, or whose size, mtime, or inode
moved, plus files already known to be created. Files present and unchanged at both ends are not
read. A created file always gets an `installedHash` (sha256 of its content); `hashFile()` returns
`undefined` rather than throwing when a file cannot be read.

When backups are enabled (`--backup`), the start snapshot additionally reads each pre-existing
regular file within the size limit, records its bytes in the journal's `beforeImages` map (keyed by
content address), and sets its `beforeHash`. That is the one place content is read before the
installer runs, and it is what makes a later overwrite or deletion restorable; with backups off the
start snapshot stores stamps only, exactly as before.

## Coverage limits (the "heuristic" part)

The backend reports these limits in its completeness label; they are not silently smoothed over.

| Area                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process attribution    | **None.** Any process that writes inside the scope during the window is attributed, installer or not. Concurrent unrelated churn is indistinguishable from installer activity.                                                                                                                                                                                                                                                          |
| Volatile scope         | Churn-only `~/Library` roots are out of the capture scope, and known database/journal sidecar shapes inside a kept root are skipped while scanning (`isVolatileChurnPath`). This narrows the blast radius; it does not add attribution, so other background writes inside scope are still attributed.                                                                                                                                   |
| Missed content change  | A content edit that leaves size, mtime, and inode unchanged is not detected, because change detection is stamp-first.                                                                                                                                                                                                                                                                                                                   |
| Renames                | Not paired. A rename surfaces as a removal plus a creation and normalizes to a deletion plus a creation/mutation, with no source→destination relationship.                                                                                                                                                                                                                                                                              |
| Before-images          | Captured only when backups are enabled (`--backup`). At `start` the fallback reads each pre-existing regular file within the size limit and keeps its bytes in the journal (`beforeImages`, keyed by content address); with backups off the start snapshot stores stamps only, so a mutation or deletion of a pre-existing file has no `beforeHash`/`beforeBlob` and is **not restorable**. Over-limit or unreadable files are skipped. |
| Symlinks               | Recorded by target, never followed; a target change reads as a replacement.                                                                                                                                                                                                                                                                                                                                                             |
| Daemonized descendants | Writes inside the scope before `stop()` are seen; writes after the window are not, and without a PID the backend cannot say a change came from the installer's tree.                                                                                                                                                                                                                                                                    |
| Unreadable scope       | A root that exists but cannot be read, or a file that cannot be hashed, sets `partialReason` (completeness stays `heuristic`).                                                                                                                                                                                                                                                                                                          |
| Case behavior          | Uses the platform table's default (macOS: case-insensitive) for path identity, matching journal normalization (D10). Per-mount probing is a later stub; when it lands, the resolved `caseSensitive` flag is stored on the record.                                                                                                                                                                                                       |

With backups off, mutations and deletions are non-restorable: uninstall can still remove owned files
whose `installedHash` matches, but it reports a conflict rather than restore a heuristic mutation.
With `--backup`, `tret install` stores the captured bytes through `FileStorage.captureBeforeImage`
and records the blob address as `beforeBlob`, so uninstall can restore a mutation or recreate a
deletion — provided the current state still matches the record (D2).

## Tests

- `src/lib/capture/macos/macos.test.ts` — scope expansion from the platform table (include/exclude) and
  the trimmed capture root set, the volatility skip (`isVolatileChurnPath` plus a window where churn
  files are not emitted while creations in kept targets are owned), pure snapshot→event diffs (create,
  write, unlink, kind change, chmod, symlink, nested `mkdir`), the hash-queue rule, case-insensitive vs
  case-sensitive collapse, and heuristic completeness labeling through normalization.
- `src/lib/capture/macos/macos.integration.test.ts` with `fixtures.ts` — builds a real pre-existing
  scope in a temp directory, runs a scripted install (edit, delete, chmod, nested create, create,
  symlink), and asserts the exact event sequence and normalized owned/mutated/deleted effects and
  their hashes.
