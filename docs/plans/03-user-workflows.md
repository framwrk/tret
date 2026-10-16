# Plan: Next user workflows

**Status:** Proposed  
**Priority:** P2 — start after safety and capture behavior are trustworthy

## Goal

Help users understand what Tret recorded, manage tracked tools over time, and capture runtime changes only when they explicitly choose to do so.

## Plan

1. [ ] **Add a record inspection or health-check command.** Show each tool's capture confidence and observation window, the paths Tret believes it owns, which files have changed since installation, which changes can be restored, and what would remain after uninstall. Make the command read-only.
2. [ ] **Add explicit runtime tracing.** After install-time capture is reliable on each supported platform, add a bounded `tret trace <tool>` workflow that asks before running the tool, records the trace as a separate segment, and merges new paths without silently taking ownership from another record. Report unsupported operations and incomplete process coverage.
3. [ ] **Support tracked-tool updates.** Add a command to re-run a tool's recorded installer source with the original arguments, show the script identity and intended changes, and retain a recovery path if the update fails. Do not remove the working install before the replacement can be fetched and validated.
4. [ ] **Make tool selection unambiguous.** Allow a user-supplied display name at install time and provide a stable record identifier for cases where multiple installs have the same command name. Ensure uninstall, update, inspect, and forget all resolve the same record predictably.
5. [ ] **Add machine-readable output.** Provide a documented JSON mode for list, inspect, dry-run uninstall, and command results. Keep installer output separate from structured output and define stable exit codes for automation.
6. [ ] **Improve installer consent and expectations.** Show the fetched installer's source and SHA-256 before execution when practical, explain that Tret observes and records changes but does not sandbox the installer, and clearly distinguish this protection from malware prevention.

## Acceptance criteria

- Users can inspect tracked paths and capture confidence without modifying records or files.
- Runtime tracing is opt-in, bounded, and appends an auditable trace segment; it does not execute a tool silently.
- A tracked-tool update preserves the original arguments and does not destroy the working install on download or validation failure.
- Duplicate command names can be selected consistently by stable identity.
- JSON output is valid when piped, has tests for success and error cases, and never mixes human prompts into its data stream.
- Install documentation explains the trust boundary in plain language.

## Dependencies and boundaries

Start runtime tracing only after the capture backends and safety checks in [Safety and data integrity](01-safety-and-data-integrity.md) and [Platform support and adoption](02-finish-platform-and-adoption.md) have meaningful regression coverage. Do not make automatic first-run execution a prerequisite for tracking an install.
