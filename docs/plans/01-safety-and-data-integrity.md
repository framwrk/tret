# Plan: Safety and data integrity

**Status:** Proposed  
**Priority:** P0 — address before expanding destructive workflows

## Goal

Make sure Tret only removes files that still match its evidence, preserves recoverable data, and keeps enough state for users to recover from failed installs or interrupted operations.

## Plan

1. **Correct change classification.** Fix journal normalization so replacing a pre-existing destination with a temporary file is recorded as a mutation, not as a newly owned file. Cover other replace-over-existing and rename cases on both backends.
2. **Enforce filesystem-root boundaries.** Normalize traced paths before checking whether they are inside an observation root. Reject paths that escape through `..`, and define how symlinked path components are handled. A lexical prefix match alone is not sufficient.
3. **Restore complete file state.** Capture and restore file permissions with before-image contents. Restore files without changing the permissions of existing parent directories.
4. **Keep shell cleanup narrowly attributable.** Remove only configuration changes Tret can tie to the install; do not remove a shared PATH entry such as `~/.local/bin` just because it contains or resembles an owned path. Preserve subsequent user edits and re-check before writing.
5. **Make record updates concurrency-safe.** Serialize read-modify-write operations so two simultaneous Tret commands cannot silently discard each other's records.
6. **Validate records deeply.** Validate nested entries, capture segments, fingerprints, backup references, and absolute paths on load; reject malformed data without overwriting the original records file.

## Acceptance criteria

- A file or symlink changed after planning or confirmation is kept unless the user explicitly requests the supported force behavior.
- Replacing an existing file is not mistaken for creating a new owned file, and a path outside the selected roots is never recorded.
- Restoring a backup restores the original file mode and leaves unrelated directory permissions unchanged.
- Shared shell PATH lines and post-install user edits survive uninstall.
- Failed installs remain inspectable and removable, and a failed download never removes the existing installation.
- Concurrent record writes retain every successful record, and malformed nested records fail closed.
- Regression tests reproduce each reviewed safety issue through the planner/applier or CLI, not only through isolated helper tests.

## Dependencies and boundaries

The v3 store already has atomic writes, private permissions, migrations, backup blobs, and garbage collection. Preserve and build on those guarantees rather than replacing them. This plan does not add new user-facing commands; it hardens install, storage, and uninstall behavior first.
