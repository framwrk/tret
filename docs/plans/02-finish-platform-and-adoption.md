# Plan: Finish platform support and adoption

**Status:** Proposed  
**Priority:** P1 — complete the platform work already represented in the code

## Goal

Make the macOS and Linux platform tables drive the real commands consistently, ensure Linux capture is usable in shipped releases, and make `tret find` adoption safe for tools installed outside Tret.

## Plan

1. **Wire the platform abstraction through commands.** Replace remaining hardcoded macOS table use in command paths such as related-file discovery and shell configuration cleanup. Use the active platform's search roots, shell files, shared-path rules, and privilege policy for `find`, install, and uninstall.
2. **Finish Linux shell and search behavior.** Handle the Linux table's shell configuration files and directory-based entries, including fish, systemd user units, desktop entries, XDG data directories, and package-manager binary directories. Do not treat a directory entry such as `/etc/profile.d` as a file to edit.
3. **Ship the Linux capture helper.** Build the fanotify helper for supported Linux release targets, include and install it with the matching Tret release artifact, and select it without requiring users to discover and configure a private `TRET_FANOTIFY` path. Keep the unprivileged `strace` option and clearly explain when it is unavailable or incomplete.
4. **Exercise real Linux capture.** Add Linux CI smoke tests that run representative installers through the shipped backend and helper where permissions allow. Keep hermetic fake-tracer tests for deterministic edge cases, and report permission, kernel, filesystem, and syscall blind spots as partial capture.
5. **Make Linux backups honest and useful.** Capture eligible before-images and their prior permission bits before the installer starts when `--backup` is enabled, or explicitly warn that Linux cannot restore them until that is implemented. The record format, planner, and applier already restore whatever a capture records (#11), so this is capture-side work. Do not advertise a backup as restorable unless its original bytes were stored and verified.
6. **Complete case-sensitivity handling.** Replace platform-wide case defaults with a probe for the filesystem holding each relevant path. Use the record's case behavior consistently when normalizing effects and detecting overlapping claims during uninstall.
7. **Make `tret find` adoption complete but conservative.** Inventory the files inside adopted tool directories, not just the top-level directory. Record enough fingerprints to remove verified files and empty directories safely; leave unrelated or changed contents untouched and explain conflicts rather than leaving an opaque, permanently stuck folder record.
8. **Expose capture-scope configuration.** Support documented additions and exclusions to the bounded observation roots so users can account for installers that write outside the defaults without widening every capture to the whole filesystem.

## Acceptance criteria

- The running platform table, rather than the macOS table, determines search and shell cleanup behavior on Linux.
- Linux release artifacts include a runnable helper where supported; fallback behavior is visible and never mislabeled as complete.
- Linux `--backup` either restores verified pre-install content or clearly reports that restoration is unavailable.
- Paths that differ only by case are treated as shared or distinct according to their actual filesystem, not a hardcoded OS guess.
- Adopting a populated tool directory produces a useful, safe uninstall plan and never recursively deletes unverified contents.
- CI covers the platform tables and at least one real Linux capture path in addition to the existing fake-backend tests.

## Outcome

Implemented on `platform/p1-finish-platform` (items 1–8 complete):

- Item 1: `find`, the snapshot scope, and the shared-path guards read the running platform table, so Linux searches its XDG and package-manager surfaces and protects `/usr`, `/etc`, and the other shared system trees instead of the macOS list.
- Item 2: shell-config cleanup walks the active table's entries, including the Linux-only `.bash_login`, fish's `config.fish`, and directory entries (`/etc/profile.d` is reported, never edited as a file).
- Item 3: the fanotify helper builds for the Linux release targets and ships inside the Linux archives; the backend discovers it beside the `tret` binary, so no private `TRET_FANOTIFY` path is needed, and the unprivileged `strace` fallback stays available.
- Item 4: a Linux smoke test runs a representative installer through the shipped `strace` backend, parser, and reconstruction on genuine kernel output, skipping cleanly where the kernel or the missing `strace` refuses it; hermetic fake-tracer tests keep the edge cases deterministic.
- Item 5: with `--backup`, the Linux capture reads each eligible pre-existing file's bytes and prior mode at window start and attaches them as before-images; a restore is claimed only for bytes storage actually holds.
- Item 6: case behavior is probed read-only per filesystem (a case-flipped spelling of the deepest existing ancestor); `install` and `find` resolve one conservative record-wide flag over every observed path, the capture backends key paths with that same flag, and uninstall folds case in shared-ownership and delegated-removal overlap checks whenever either record was on a case-insensitive filesystem. The platform defaults remain only as the last resort when nothing can be probed.
- Item 7: `tret find` fingerprints every node under an adopted directory (files by content hash, symlinks by target and never followed) and records a node that is neither a regular file, directory, nor symlink as present-but-unverifiable instead of reading it, so a FIFO cannot hang the walk. Uninstall then removes the verified files and the directories that empty, while a changed file or unrelated survivor becomes a conflict naming that exact path instead of leaving an opaque, permanently stuck folder record.
- Item 8: `tret install --observe <path>` adds an absolute root to that install's capture scope and `--observe-exclude <path>` drops one of the platform's default roots, both repeatable and documented in the README, `tret help`, and the capture docs. The heuristic fallback follows the resolved roots exactly (it no longer re-adds `$HOME`), so the scope a record covers does not depend on which backend attached.

## Dependencies and boundaries

The re-verification, root-boundary, and shared-ownership work in [Safety and data integrity](01-safety-and-data-integrity.md) is complete; build on it before enabling real destructive operations on newly supported paths. Keep the shared record format and capture-backend seam; do not fork core install or uninstall logic by operating system.
