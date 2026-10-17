# Plan: Safety and data integrity

**Status:** Done — implemented and merged to `main` in #11  
**Priority:** P0 — address before expanding destructive workflows

## Goal

Make sure Tret only removes files that still match its evidence, preserves recoverable data, and keeps enough state for users to recover from failed installs or interrupted operations.

## Plan

1. [x] **Correct change classification.** Fix journal normalization so replacing a pre-existing destination with a temporary file is recorded as a mutation, not as a newly owned file. Cover other replace-over-existing and rename cases on both backends.
2. [x] **Enforce filesystem-root boundaries.** Normalize traced paths before checking whether they are inside an observation root. Reject paths that escape through `..`, and define how symlinked path components are handled. A lexical prefix match alone is not sufficient.
3. [x] **Restore complete file state.** Capture and restore file permissions with before-image contents. Restore files without changing the permissions of existing parent directories.
4. [x] **Keep shell cleanup narrowly attributable.** Remove only configuration changes Tret can tie to the install; do not remove a shared PATH entry such as `~/.local/bin` just because it contains or resembles an owned path. Preserve subsequent user edits and re-check before writing.
5. [x] **Make record updates concurrency-safe.** Serialize read-modify-write operations so two simultaneous Tret commands cannot silently discard each other's records.
6. [x] **Validate records deeply.** Validate nested entries, capture segments, fingerprints, backup references, and absolute paths on load; reject malformed data without overwriting the original records file.

## Acceptance criteria

- A file or symlink changed after planning or confirmation is kept unless the user explicitly requests the supported force behavior.
- Replacing an existing file is not mistaken for creating a new owned file, and a path outside the selected roots is never recorded.
- Restoring a backup restores the original file mode and leaves unrelated directory permissions unchanged.
- Shared shell PATH lines and post-install user edits survive uninstall.
- Failed installs remain inspectable and removable, and a failed download never removes the existing installation.
- Concurrent record writes retain every successful record, and malformed nested records fail closed.
- Regression tests reproduce each reviewed safety issue through the planner/applier or CLI, not only through isolated helper tests.

## Outcome

Complete on `main`, merged with #11. Items 1 (change classification) and 4 (narrow shell cleanup) had landed earlier; items 2, 3, 5, and 6 were implemented on `safety/p0-hardening`:

- Item 2: traced paths are normalized lexically and their parent resolved through symlinks before recording; a resolved escape is dropped with a diagnostic.
- Item 3: mutations and deletions carry the pre-install permission bits; a restore writes the before-image with that mode and never re-permissions an existing parent directory.
- Item 5: `saveRecord`/`removeRecord` serialize their read-modify-write through `records.json.lock`, reclaim a stale lock, and fail closed after a bounded wait.
- Item 6: v3 records are validated deeply on load and before write; malformed nested data is rejected without overwriting the original records file.

The Linux capture-side before-image gap is closed by item 5 in [Platform support and adoption](02-finish-platform-and-adoption.md): with `--backup`, Linux now captures eligible pre-install contents and mode. Mutations and deletions remain non-restorable whenever an actual before-image was not stored, such as when backups are off or a file exceeds the size limit.

## Dependencies and boundaries

The v3 store already has atomic writes, private permissions, migrations, backup blobs, and garbage collection. Preserve and build on those guarantees rather than replacing them. This plan does not add new user-facing commands; it hardens install, storage, and uninstall behavior first.
