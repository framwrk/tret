# Plan: Release confidence and documentation

**Status:** Proposed  
**Priority:** P1 — make every change verifiable before release

## Goal

Run the same meaningful checks before changes are merged and before artifacts are published, and ensure the documentation describes the behavior users actually receive.

## Plan

1. **Run CI on pull requests.** Add pull-request triggers to the existing CI workflow so branches receive checks before merge, rather than running the main CI workflow only after a push to `main`.
2. **Type-check in CI.** Add a documented type-check command and run it alongside lint and tests. Keep local and CI commands aligned.
3. **Keep the platform matrix honest.** Build and test every advertised OS/architecture target, verify archives and checksums, and include the Linux capture helper in the release and install-script tests when applicable.
4. **Add end-to-end regression coverage.** Test the reviewed uninstall race, overwritten-file classification, path-root escapes, backup mode restoration, failed installs without an executable, failed forced-reinstall downloads, concurrent record updates, and populated `tret find` directories. Run a real Linux tracer smoke test on a suitable runner; retain fake backends for deterministic cases.
5. **Test shipped behavior, not just source modules.** Continue exercising the install script against built archives, and add release checks that install, report the version, and update a binary for each target without relying on an interactive terminal or live filesystem outside a temporary home.
6. **Align user-facing documentation.** Update the README and command help to match actual capture coverage, backup availability by platform, `find` behavior, uninstall safety, and the trust boundary for remote install scripts. Clearly identify platform features that remain unavailable.
7. **Publish a release checklist.** Require green PR checks, successful builds for all supported targets, verified checksums, and reviewed notes for any known capture limitations before tagging a release.

## Acceptance criteria

- Pull requests receive lint, tests, type checks, and target builds before merge.
- Every supported release target is built and install-tested; platform-specific helper assets are present and executable where promised.
- High-risk regressions have end-to-end tests, not only unit tests.
- README, help text, capture docs, install scripts, and shipped artifacts agree about supported behavior.
- A release cannot be considered ready while a required target or security regression check is failing or skipped without an explicit reason.

## Dependencies and boundaries

This plan verifies the work in [Safety and data integrity](01-safety-and-data-integrity.md), [Platform support and adoption](02-finish-platform-and-adoption.md), and [Next user workflows](03-user-workflows.md). It does not authorize publishing a release; release publication still requires the repository owner's approval.
