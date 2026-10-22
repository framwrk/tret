# Plan: Next user workflows

**Status:** Complete — implemented and merged to `main` in #17  
**Priority:** P2 — start after safety and capture behavior are trustworthy

## Goal

Help users understand what Tret recorded, manage tracked tools over time, and capture runtime changes only when they explicitly choose to do so.

## Plan

1. [x] **Add a record inspection or health-check command.** Show each tool's capture confidence and observation window, the paths Tret believes it owns, which files have changed since installation, which changes can be restored, and what would remain after uninstall. Make the command read-only.
2. [x] **Add explicit runtime tracing.** After install-time capture is reliable on each supported platform, add a bounded `tret trace <tool>` workflow that asks before running the tool, records the trace as a separate segment, and merges new paths without silently taking ownership from another record. Report unsupported operations and incomplete process coverage.
3. [x] **Support tracked-tool updates.** Add a command to re-run a tool's recorded installer source with the original arguments, show the script identity and intended changes, and retain a recovery path if the update fails. Do not remove the working install before the replacement can be fetched and validated.
4. [x] **Make tool selection unambiguous.** Allow a user-supplied display name at install time and provide a stable record identifier for cases where multiple installs have the same command name. Ensure uninstall, update, inspect, and forget all resolve the same record predictably.
5. [x] **Add machine-readable output.** Provide a documented JSON mode for list, inspect, dry-run uninstall, and command results. Keep installer output separate from structured output and define stable exit codes for automation.
6. [x] **Improve installer consent and expectations.** Show the fetched installer's source and SHA-256 before execution when practical, explain that Tret observes and records changes but does not sandbox the installer, and clearly distinguish this protection from malware prevention.

## Acceptance criteria

- Users can inspect tracked paths and capture confidence without modifying records or files.
- Runtime tracing is opt-in, bounded, and appends an auditable trace segment; it does not execute a tool silently.
- A tracked-tool update preserves the original arguments and does not destroy the working install on download or validation failure.
- Duplicate command names can be selected consistently by stable identity.
- JSON output is valid when piped, has tests for success and error cases, and never mixes human prompts into its data stream.
- Install documentation explains the trust boundary in plain language.

## Outcome

Complete on `main`, merged with #17 (`feat(workflows): add inspect, trace, tracked-tool update, and JSON output`):

- Item 1: `tret inspect <tool>` prints a read-only health check for one record — capture confidence, the observation window and its segments, the owned paths and whether they still match their installed fingerprint, the files changed since install and whether a before-image can restore them, and the actions `uninstall` would take. It runs the same uninstall planner in preview mode and writes nothing to disk or to the records file.
- Item 2: `tret trace <tool>` asks for confirmation on an interactive terminal before it runs the tool, records the run in a bounded observation window, and appends the result as a separate `trace` segment next to the install segment. A path another record already claims is reported and skipped instead of taken over, and partial or heuristic coverage is reported with its reason.
- Item 3: `tret update <tool>` re-runs the record's installer URL with the arguments the record kept in `scriptArgs`, preserving the record's id and display name. The replacement script is fetched and its SHA-256 checked before the working install is touched, so a failed download or validation leaves the previous install in place, and a failed removal keeps a reduced record that `tret uninstall` can retry.
- Item 4: `tret install --name <name>` records a tool under a chosen display name, and every single-record command resolves its argument the same way: an exact record id wins, a unique display name resolves, and a name shared by several records lists the candidates by id instead of picking one. `record-target.ts` keeps uninstall, inspect, and update planning the same filtered set of paths.
- Item 5: `--json` makes a command write exactly one JSON document to stdout while human lines and installer output are routed to the terminal or stderr, so a piped run stays valid JSON. `tret --help` documents stable exit codes 0–5 for automation.
- Item 6: before the installer runs, Tret prints its URL, its SHA-256, and a bounded preview of the script, then asks for confirmation on an interactive terminal. The same output states that Tret observes and records what the installer changes but does not sandbox it or prevent malware.

## Dependencies and boundaries

Start runtime tracing only after the capture backends and safety checks in [Safety and data integrity](01-safety-and-data-integrity.md) and [Platform support and adoption](02-finish-platform-and-adoption.md) have meaningful regression coverage. Do not make automatic first-run execution a prerequisite for tracking an install.
