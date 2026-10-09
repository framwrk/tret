# Rewrite integration validation report

**Branch:** `rewrite/integration`
**Integration commit:** `c71500a` (merge `61a9f1b`; small fixes)
**Inputs merged:** `rewrite/trace` (`16831ef`) + `rewrite/distribution` (`ef00902`), both on top of the plan base `661b527`.
**Host:** macOS 27 (Darwin, arm64). Bun `1.4.2`. Node not present; all runs use `~/.bun/bin/bun`.
**Date:** 2026-10-09.

## 1. Decision

**Do not remove the legacy snapshot path. Do not merge `rewrite/integration` as-is.**

The library layers that landed (platform seam, capture backends, journal normalization, v3 record,
content-addressed storage, v2→v3 migration, verified uninstall planner/applier, distribution) are
individually strong and almost all tests pass. But the **install-side integration (plan phase 5) and
the command rewiring (plan phase 9) were never done**: `install`/`find`/`list` still read and write
the legacy v2 `added`/`edited` records, while `uninstall` reads the new v3 store. The result is a
split-brain that breaks the primary workflow end to end and can corrupt a user's `records.json`.

Parity therefore does **not** hold, and the legacy path is still the only thing that produces an
install record. Removing it would break `install` outright.

## 2. What was run

| Check | Command | Result |
| --- | --- | --- |
| Unit/integration suite | `bun test` | **223 pass / 0 fail** (25 files) |
| Type check | `bunx tsc --noEmit` | **clean** (was 6 errors; fixed) |
| Lint (CI gate) | `bunx eslint .` | **clean** |
| Build + install script | `bash scripts/build.sh darwin-arm64` then `bash scripts/install.test.sh` | **OK for `tret-darwin-arm64`** |
| Manual scenarios | isolated `$HOME` + local HTTP installer (see §5) | mixed: see verdicts |

## 3. Acceptance criteria verdicts

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Record distinguishes created / modified / deleted and records capture completeness | **FAIL (CLI)** | The `RecordV3` model, normalizer, and migration do this, but a real `tret install` writes a v2 record with only `added`/`edited`, no `deleted`, no `capture` (§5-S1). |
| 2 | Uninstall verifies state and preserves diverged data | **PARTIAL** | Verified planner/applier passes remove/restore/deleted/conflict and dry-run parity on hand-built v3 records (§5-S2/S3). But records produced by `install` migrate to `kind:"unknown"` with no hashes, so uninstall removes **nothing** and only reports conflicts (§5-S1). |
| 3 | Backups enabled are bounded, private, integrity-checked, never silently overwrite | **PARTIAL (library only)** | `store.test.ts` (26) + `removal-verify.test.ts` cover dedup, permissions, size limit, corruption, GC, restore conflicts. No CLI opt-in exists and `install` never writes a `beforeBlob`, so restore is unreachable from the shipped commands. |
| 4 | Existing records migrate without loss or fabricated restore | **PASS** | Verified on a representative 3-record v2 sample (§4). |
| 5 | Tests show documented coverage; CLI labels heuristic/partial | **PARTIAL** | Backend/normalize/session tests are thorough and `install` prints the coverage label. `tret list` does **not** show completeness (README claims it) and crashes on any v3 file (§5-S4). |
| 6 | README claims match shipped behavior | **FAIL** | README describes journal-based install, v3 records, `list` completeness, backups opt-in, partial record on installer failure, and sudo-aware installs. Shipped `install` is v2-only, `list` crashes, backups are unreachable, a failed installer saves no record (§5-S5), and `privilege` is hard-coded `"user"`. |
| 7 | Shared core builds/tests against macOS + Linux table; adding a platform is a backend + table | **PASS (with caveats)** | Suite green; `platform.test.ts` exercises both tables; Linux backend/conformance/integration run hermetically with fake tracers. Caveats: no real Linux host run, and artifact naming is duplicated between `src/lib/artifacts.ts` and `Platform.artifacts` (a second place to edit per platform). |

## 4. v2 → v3 migration (criterion 4) — PASS

Sample: a realistic v2 file with an `install` record (added + edited), a pre-`source` legacy record,
and a `find` record. Read through `FileStorage.loadRecords()`:

```
record count: 3
names: deltool,oldtool,adopted
capture: legacy-v2 / heuristic for all three
owned kinds: [["unknown","unknown"],["unknown"],["unknown"]]
mutated counts: 1,0,0
fabricated beforeHash/blob: false
find preserved: find
on-disk version after read: 3 records: 3
idempotent IDs: true
malformed threw: RecordsCorruptionError
original bytes preserved: true
```

- No entries dropped; every `added`→owned and `edited`→mutated mapping retained.
- No fabricated hashes or before-images; migrated records are `heuristic`/detect-only.
- File upgraded to v3 atomically; second read idempotent.
- A malformed v2 file throws `RecordsCorruptionError` and leaves the original bytes untouched.
- `uninstall`'s CLI read on a corrupt file prints the error and exits 1 without writing (§5-S1 note).

## 5. Manual scenarios (macOS)

Runner: temp `$HOME`, installer served from `python3 -m http.server`; `bun index.ts …`.

### S1. install → list → uninstall — **FAIL (critical)**

Installer: creates `~/.local/bin/mytool`, `~/.config/mytool/config`, appends to `~/.zshrc`.

`tret install` succeeds and prints the coverage label, but the record is v2 and the captured
journal is discarded:

```
observed the install with macos-heuristic: heuristic attribution, no process tree; ...; 6 events over 20 roots
installed mytool
	added 3 files and folders
	edited 0
	deleted 0
```

`~/.tret/records.json` is `version: 2` with `added`/`edited` only.

`tret uninstall mytool --dry-run` then migrates v2→v3 on read and plans **no removals**:

```
conflict …/.local/bin/mytool (unverified)
conflict …/.config/mytool (unverified)
conflict …/.zshrc (unverified)
```

`tret uninstall mytool --yes` exits 1, removes nothing, and keeps the record:

```
keep …/.local/bin/mytool (unverified)
Error
	some paths were not removed and stay tracked; run tret uninstall again to retry
```

### S2. Dry-run parity — **PASS for v3 records**

With a hand-built v3 record (owned file + mutation with before-image + deletion), `--dry-run` and
`--yes` enumerated identical actions:

```
would remove …/.local/bin/widget      | remove …
would restore …/.config/widget.conf   | restore …   (content restored to OLD)
would restore …/.config/gone.conf     | restore …   (content restored to GONE)
```

Outcome: file removed, both files restored, record dropped. Dry-run cannot diverge from apply
because both share one `UninstallPlan` (also covered by `uninstall-planner.test.ts` "dry-run parity").

### S3. Restore + conflict cases — **PASS for v3 records**

Diverged owned file (recorded hash ≠ current content): dry-run `conflict … (modified)`;
apply keeps it, retains the record, exits 1. Restore/deletion verified in S2. These are only
reachable if a v3 record exists; `install` cannot produce one (§S1), and backups are never enabled.

### S4. Capture completeness labeling — **PARTIAL**

`install` prints the label. `list` does not; and because `list` still uses the v2 loader it throws
on a v3 file:

```
TypeError: undefined is not an object (evaluating 'record.added.length')
    at src/commands/list.ts:23:28
```

Since `uninstall` migrates to v3 on first read, **any `tret list` after any uninstall crashes.**

### S5. Failed installer — **FAIL vs README**

Installer creates a file then `exit 3`. `install` exits 1 and reads no record at all (the record is
only written after the exit-code check):

```
Error
	install script exited with code 3: …
$ ls ~/.tret/records.json   → No such file or directory
tret list                  → No installs tracked.
```

The partial file is left orphaned with no record. README line 70 claims Tret "keeps a **partial**
record". Plan phase 5 requires labeling partial capture, not silently writing nothing.

### S6. Record corruption cycle — **FAIL (data integrity)**

Legacy `saveRecord` (`records.ts`) always writes `{version: 2}` and does not understand v3 records.
Any legacy write after a v3 migration embeds v3 records in a v2 file:

1. `tret uninstall toolA` migrates `records.json` to v3.
2. `tret find toolB` (or `install`) calls legacy `saveRecord` → file drops back to `version: 2` with a
   v3 record mixed in.
3. `tret uninstall toolA` now fails to read it:

```
Error
	could not read the install records: corrupt records file at …/records.json: records file has malformed records
```

`tret install --force` also crashes in the same state (`removeAdded` gets an undefined `added` at
`src/commands/install.ts:51`). This reaches real users because `uninstall` migrates in place.

## 6. Plan test-bullet coverage

| Required coverage | Status | Where |
| --- | --- | --- |
| create/write, overwrite, delete, rename-overwrite, symlink, chmod, temp-file, nested-dir, create-then-delete | Covered | `journal/normalize.test.ts` (24), `capture/linux/reconstruct.test.ts` (8), `macos.test.ts` (15) |
| unrelated churn not attributed | Covered | `capture/linux/linux.integration.test.ts` (out-of-scope marker dropped) |
| partial/daemonized reported incomplete | Covered | `capture/linux/backend.test.ts`, `linux.conformance.test.ts`, `session.test.ts` |
| hash change with preserved mtime / noisy metadata ignored | Covered | `journal/normalize.test.ts` |
| shared paths, two records, pre-existing, replaced, dirs with user files | Covered | `uninstall-planner.test.ts` (24) |
| backup dedup, permissions, size limits, corrupt/missing blobs, restore conflicts, GC | Covered | `store.test.ts` (26), `removal-verify.test.ts` (9), `storage.test.ts` (4) |
| dry-run equivalence, interrupted/partial cleanup + retry | Covered | `uninstall-planner.test.ts`, `removal-verify.test.ts` |
| v2 migration, malformed records, atomic-write failure, legacy non-restorable | Covered | `records.test.ts` (16), `store.test.ts` |
| shell config appended/rewritten/user-edited | Covered | `shellconfig.test.ts` (8) |
| first-run/lazy writes + trace-session boundaries | Covered (trace deferred D5) | `session.test.ts` (13) |
| macOS/Linux platform tables, guards, shell configs, artifacts, case behavior | Covered | `platform.test.ts` (10), `artifacts.test.ts` (8) |
| privilege: root capture, sudo-aware uninstall, rejection/warning | **Partial** | planner `requiresSudo` + platform policy tests; no root capture at the CLI |
| self-update / install.sh across `{darwin,linux}×{arm64,x64}` | **Partial** | `artifacts.test.ts`, `updatecheck.test.ts` (unit); `install.test.sh` runs only the host target |

## 7. Blockers (scoped)

- **B1 (critical) — install integration missing (phase 5).** `src/commands/install.ts` runs the
  bounded capture session and then ignores its journal: it still calls `snapshot()`/`diff()` and
  `saveRecord()` (v2) at lines 90–134. The fix is to normalize `session.journal` with
  `normalizeJournal(...)` and persist a `RecordV3` through `FileStorage`.
- **B2 (critical) — v2/v3 split in commands (phase 9).** `find.ts`/`list.ts` use the legacy
  `records.ts`; `uninstall.ts` uses `FileStorage`. `list.ts` throws on v3 records.
- **B3 (critical) — record corruption.** Legacy `saveRecord`/`removeRecord` in `records.ts`
  unconditionally write `version: 2`, mixing shapes and making the file unreadable to `FileStorage`.
  They must be replaced by the v3 store (or refuse to downgrade).
- **B4 (high) — capture effects discarded.** Because of B1, owned/mutated/deleted + hashes +
  completeness never reach disk; `uninstall` cannot safely remove a freshly installed tool.
- **B5 (high) — backups unreachable.** No CLI opt-in and no `install` before-image capture; criterion 3
  is library-only.
- **B6 (medium) — failed installer record.** Plan/README require a labeled partial record; install
  writes none.
- **B7 (medium) — privilege not recorded from the process.** `install.ts` hard-codes
  `platform.privilege.defaultPrivilege` (`"user"`); a `sudo` install is misrecorded, so the
  sudo-aware uninstall path cannot trigger correctly (D8).
- **B8 (medium) — `list` missing completeness / crashing.** Needs to read the v3 store and print
  `capture.completeness`.
- **B9 (low) — artifact naming duplicated.** `src/lib/artifacts.ts` and `Platform.artifacts` both
  encode the matrix; fold one into the other so adding a platform stays one table + one backend.

## 8. Small fixes applied on this branch

- `src/lib/capture/macos/scoped.ts`: typed `lstat` results as `Stats` instead of the
  `number | bigint` union (`ReturnType<typeof lstatSync>`), removing 5 type errors.
- `src/lib/capture/macos/macos.test.ts`, `src/lib/updatecheck.test.ts`: narrowed an event union and a
  `fetch` cast so `bunx tsc --noEmit` is clean.
- `src/commands/uninstall.ts`: stop printing a conflict/skip twice (`keep …` plan line followed by
  `kept …` outcome). Announced conflicts/skips are now reported once.
- Merge of `rewrite/distribution` reconciled `README.md` (How-it-works, command table, development
  section).

No behavioral change was made to `records.ts`/`install.ts`/`list.ts`; those are B1–B3 and need the
phase 5/9 work rather than a spot fix that could mask the split.

## 9. Remediation plan (to make parity hold)

1. **Phase 5 — install writes v3.** Return `journal` from `observeInstall`, then in `install`:
   `normalizeJournal({ journal, backups, caseSensitive })`; derive `name`/`executable` from the
   normalized `owned` entries (reuse `pickExecutable` over owned file paths); and
   `FileStorage.saveRecord(record)`. Persist a labeled `partial` record when the installer exits
   non-zero. Set `privilege` from `process.getuid() === 0`.
2. **Phase 9 — rewire commands.** `find` builds v3 owned entries (kind/hash via `inspectPath`);
   `list` becomes async and reads `FileStorage`, printing `capture.completeness` and owned/mutated/
   deleted counts; `--force` reinstall plans through `VerifiedUninstallPlanner` + `applyUninstallPlan`.
3. **Remove the legacy path only after (1)+(2)** delete `snapshot.ts`/`diff.ts` usage, the v2
   `ToolRecord` write helpers, the name-based `removeAdded` reinstall branch, and `first-run.ts`
   (already gone).
4. **Add end-to-end tests** that fail today: install→uninstall via a local fixture installer asserting
   the tool is removed; `list` renders a v3 record; legacy write after a v3 migration does not corrupt.
5. **Backups opt-in** surfaced in `install` config/flags before claiming criterion 3.

## 10. Merge recommendation

Hold. Green `bun test` is necessary but not sufficient here: no test exercises `install`→`uninstall`,
so the suite is green while the product is broken. Land B1–B3 (and the S6 corruption fix) with the
end-to-end tests in §9.4 before removing the legacy snapshot path or merging to `main`.
