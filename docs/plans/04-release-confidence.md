# Plan: Release confidence and documentation

**Status:** Complete — all items are implemented.

**Priority:** P1 — make every change verifiable before release

## Goal

Run the same meaningful checks before changes are merged and before artifacts are published, and ensure the documentation describes the behavior users actually receive.

## Plan

1. [x] **Run CI on pull requests.** Add pull-request triggers to the existing CI workflow so branches receive checks before merge, rather than running the main CI workflow only after a push to `main`.
2. [x] **Type-check in CI.** Add a documented type-check command and run it alongside lint and tests. Keep local and CI commands aligned.
3. [x] **Keep the platform matrix honest.** Build and test every advertised OS/architecture target, verify archives and checksums, and include the Linux capture helper in the release and install-script tests when applicable.
4. [x] **Add end-to-end regression coverage.** Test the reviewed uninstall race, overwritten-file classification, path-root escapes, backup mode restoration, failed installs without an executable, failed forced-reinstall downloads, concurrent record updates, and populated `tret find` directories. CLI/applier coverage exercises uninstall revalidation, overwrite/backup restoration, failed-install recovery, populated `find`, concurrent `find` commands racing on one records file, and an install whose reconstruction drops a resolved-root escape before the record is written; a conditional real Linux `strace` smoke test and hermetic fake-backend tests remain in place.
5. [x] **Test shipped behavior, not just source modules.** Continue exercising the install script against built archives, and add release checks that install, report the version, and update a binary for each target without relying on an interactive terminal or live filesystem outside a temporary home.
6. [x] **Align user-facing documentation.** Update the README and command help to match actual capture coverage, backup availability by platform, `find` behavior, uninstall safety, and the trust boundary for remote install scripts. Clearly identify platform features that remain unavailable.
7. [x] **Publish a release checklist.** Require green PR checks, successful builds for all supported targets, verified checksums, and reviewed notes for any known capture limitations before tagging a release.

## Acceptance criteria

- Pull requests receive lint, tests, type checks, and target builds before merge.
- Every supported release target is built and install-tested; platform-specific helper assets are present and executable where promised.
- High-risk regressions have end-to-end tests, not only unit tests.
- README, help text, capture docs, install scripts, and shipped artifacts agree about supported behavior.
- A release cannot be considered ready while a required target or security regression check is failing or skipped without an explicit reason.

## Outcome

Implemented on `chore/release-confidence`:

- Item 2: `bun run typecheck` runs `tsc --noEmit`, is documented in the README development table, and runs in both CI and the release build job. The one pre-existing type error was a union member access in `strace.test.ts`; `main` fixed it independently while this branch was open, so the branch carries only the script and the two workflow steps.
- Item 4: `records-concurrency.test.ts` starts six `find` commands against one empty store and asserts every record survives; `install-escape.test.ts` drives the install command through the shipped reconstruction step against the real filesystem, with a symlinked parent outside the observation root, and asserts the escaped directory never reaches the record. While wiring that test, the Linux backend was found to discard reconstruction diagnostics: an escaped path was dropped but the window still claimed `complete`. The backend now folds those diagnostics into its completeness reasons, a backend test pins the `partial` label and reason, and the capture contract was updated. Existing CLI/applier tests already covered uninstall revalidation, overwrite/backup restoration, failed-install recovery, and populated `find` directories.
- Item 5: `scripts/install.test.sh` now runs the installed binary with `--version`, compares it with the built artifact, replaces a deliberately stale installed binary through the same install-script path `tret update` uses, and verifies the restored checksum and version.
- Item 6: the README gains capture-coverage, platform-limit, `find`, and trust-boundary sections; the capture section names `tret trace` as the way a later run is recorded and `tret inspect` as the way to see what a segment covers, because those commands landed on `main` before this branch merged; `tret --help` states the capture mechanism and that Tret does not sandbox installers; `--backup` documents that only eligible regular files are restorable.
- Item 7: `docs/release-checklist.md` requires green checks for every target, local build/install/checksum verification, reviewed capture limitations in the release notes, owner approval, and a post-publish install check. The README links to it before a release.

## Dependencies and boundaries

This plan verifies the work in [Safety and data integrity](01-safety-and-data-integrity.md), [Platform support and adoption](02-finish-platform-and-adoption.md), and [Next user workflows](03-user-workflows.md). It does not authorize publishing a release; release publication still requires the repository owner's approval.
