<div align="center">

# Tret

**Observe CLI installs. Approve and verify cleanup.**

[![Release](https://img.shields.io/github/v/release/framwrk/tret?sort=semver&label=release)](https://github.com/framwrk/tret/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20arm64%2Fx64-black.svg)](#platform)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-f472b6.svg)](https://bun.sh)

[Install](#install) · [Commands](#commands) · [Uninstall](#uninstall) · [Capture](#capture) · [JSON](#json-and-exit-codes) · [Development](#development) · [License](#license)

</div>

## Install

```bash
curl -fsSL https://tret.framwrk.com/scripts/install.sh | bash
```

- Installs the latest release to `~/.tret/bin/tret`.
- Links it as `~/.local/bin/tret`.
- Verifies the archive against `checksums.txt`.

### Update

- `tret update` — update Tret itself.
- `tret update <tool>` — re-run that tool's recorded installer with its saved capture settings.
- Reinstalling Tret uses the same install command above.

### Platform

| OS    | Architectures  |
| ----- | -------------- |
| macOS | `arm64`, `x64` |
| Linux | `arm64`, `x64` |

- Windows is not supported.

## Commands

| Command                                     | Purpose                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `tret install <URL>` (`add`)                | Run an installer in a capture window and record what it changed      |
| `tret uninstall <tool>` (`remove`, `unadd`) | Remove owned files after fingerprint checks                          |
| `tret unclaim <tool> <path>`                | Drop one record's claim on a shared path without deleting files      |
| `tret list` (`show`)                        | List tracked tools, capture confidence, and install state            |
| `tret inspect <tool>`                       | Show the record, owned paths, changes, and planned uninstall actions |
| `tret trace <tool>`                         | Run a tracked tool in a capture window and append the segment        |
| `tret find <tool>`                          | Adopt an already-installed command and fingerprint its files         |
| `tret forget <tool>`                        | Stop tracking a tool without touching its files                      |
| `tret update [tool]`                        | Update Tret, or re-run one tool's recorded installer                 |

### Flags

| Flag                       | Applies to                                | Effect                                                                    |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `--json`                   | all commands except `find`                | One JSON document on stdout                                               |
| `--yes`                    | `install`, `uninstall`, `trace`, `update` | Skip the confirmation prompt                                              |
| `--force`                  | `install`, `uninstall`                    | Allow known fingerprint mismatches; shared claims still block cleanup |
| `--dry-run`                | `uninstall`                               | Preview without changing anything                                         |
| `--backup`                 | `install`                                 | Store before-images for restore                                           |
| `--backup-size <bytes>`    | `install`                                 | Per-file before-image limit; requires `--backup`; default 1 MiB           |
| `--observe <path>`         | `install`                                 | Add an absolute observation root; repeatable                              |
| `--observe-exclude <path>` | `install`                                 | Drop a default observation root; repeatable                               |
| `--name <name>`            | `install`                                 | Set the recorded display name                                             |

- Anything after `--` goes to the install script: `tret install <URL> -- --skip-browser`.
- A flag cannot be mistaken for a tool name; selectors are names or record ids.
- `--version`, `help`, and the human `list` table write to stdout when piped.
- Progress, prompts, and installer output stay on the terminal or stderr.

### Examples

```bash
tret install https://example.com/install.sh
tret install https://example.com/install.sh --backup
tret install curl -fsSL https://example.com/install.sh | bash
tret list
tret inspect opencode
tret inspect opencode --json | jq '.tool.actions'
tret trace opencode --yes
tret update opencode
tret uninstall opencode --dry-run
```

- `install` names the tool from the executable it adds.
- `install` prints the URL, script hash, preview, and asks for consent unless `--yes`. Noninteractive and JSON installs require `--yes`.
- A failed installer keeps a partial record of observed changes.
- A no-executable install keeps a partial record and exits non-zero.
- `trace` runs the real tool, so it also asks for consent.
- `inspect` is read-only.

## Uninstall

Capture and `find` record candidates. A fingerprint, backup or `complete` label
supplies no cleanup authority, including for older records. Approve each supported
object explicitly before removing or restoring it:

```bash
tret inspect opencode
tret approve opencode ~/.local/bin/opencode --remove --yes
tret uninstall opencode --approved-only --dry-run
tret uninstall opencode --approved-only --yes
tret recover
```

- `approve <tool> <path> --remove|--restore` binds one action to the current object,
  its parents and content/link state. It is user authorization, not process proof.
  JSON/noninteractive approval requires `--yes`. Directories grant no authority over descendants.
  `approve <tool> <path> --revoke --yes` withdraws a decision without reading or changing
  the target, so later user work can stay outside an approved cleanup scope.
- Default uninstall requests **all recorded effects**. Missing approvals, unavailable
  restoration, shared claims and unsupported scopes refuse before any target changes
  (exit `5`). `--approved-only` explicitly narrows the scope and names retained effects;
  those effects and their record remain available after the executable is gone.
- A dry-run uses the same preflight as apply. Restore requires a valid before-image;
  a stored reference alone is insufficient. Native application uses pinned directory
  descriptors, private staging and no-replace renames. Unsupported capabilities refuse work.
- `--force` permits a previewed installed-fingerprint mismatch only when the exact
  current object has a valid cleanup approval. It never grants authority, bypasses
  shared claims or accepts a changed object/ancestor.
- Shell lines are never removed by names, PATH mentions or markers. Unsupported shell
  edits and package/managed payloads stay unresolved; no manager or recursive cleanup runs.
  A narrower approved scope may remove an explicitly approved launcher while retaining
  its unresolved profile or managed payload for manual reconciliation.
- `tret unclaim <tool> <path>` drops a shared claim without editing files.
- `tret forget <tool>` drops active tracking without deleting files. Recovery evidence
  and legacy originals can still retain blob references.
- `tret recover [operation-id]` reads operation/receipt summaries. `--resume --yes`
  reconciles supported checkpoints without rerunning external code; `--discard --yes`
  relinquishes evidence and blob pins. Discard leaves target and staging files intact
  and retains their locations for manual reconciliation.

Exit `0` verifies the named cleanup scope, not machine-wide or historical reversal.
A failure during apply exits `1` with retained evidence. Unfinished operations or
retained native objects block new mutations until explicitly reconciled/discarded.

### Shared paths

- Two records claiming one path block uninstall until resolved.
- `unclaim` changes no files and leaves the remaining record untouched.
- `unclaim` refuses paths the record does not claim or paths only that record claims.
- Delegated-removal overlaps always block, even with `--force`.
- Ordinary file and shell-config shared claims also block with `--force`.

```bash
tret unclaim opencode ~/.local/bin/opencode
```

### Remove Tret itself

```bash
curl -fsSL https://tret.framwrk.com/scripts/uninstall.sh | bash
```

Manual removal:

```bash
rm ~/.local/bin/tret
rm ~/.tret/bin/tret
rm -rf ~/.tret
```

## Capture

| Platform | Backend                                                                | Notes                                                                |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| macOS    | `macos-heuristic`                                                      | Scoped before/after snapshot; no process attribution                 |
| Linux    | `linux-strace`, then `linux-heuristic` fallback (also when root) | `ptrace_scope=1` forces the heuristic fallback for unprivileged runs |

- Capture covers bounded observation roots under `$HOME`; `--observe` and `--observe-exclude` adjust them.
- Tool updates preserve capture enablement, backup policy and size limit, and observation additions/exclusions. Older records without saved settings use the install defaults.
- Backups store only files at or below the per-file limit.
- Without a permitted before-image, mutations and deletions remain unresolved. Default cleanup refuses them; an explicitly approved subset retains them by name.
- `complete` means the tracer observed the full process tree with no known blind spot; otherwise the window is `partial`.
- Known Linux gaps: cross-root renames, `openat2` creates, mmap writes, xattr/ownership changes, and hard links.
- The CLI never selects fanotify automatically, even as root or with an adjacent helper / `TRET_FANOTIFY`. Development code must inject it explicitly; it always reports `partial`. Its observations have no automatic removal authority. Native event fidelity remains unverified.
- macOS change detection is stamp-based and can miss edits that preserve size, mtime, and inode.

### Trust boundary

- Installers and traced tools run with your user privileges.
- Tret observes and records changes; it does not sandbox or prevent malware.
- Tret never escalates to `sudo` on its own.
- Use HTTPS sources you trust.
- See [capture and removal safety](docs/safety-contract.md) for classification,
  filesystem revalidation, backup exclusions, and remaining limits.
- Legacy record reads do not persist migration. Version 4 stores add per-effect decisions and monotonic revisions; older binaries refuse them. Before external work, the format barrier and durable intent are written. The first migration preserves the exact original; see [record storage and recovery](docs/recovery.md) for retained evidence, lock behavior, and current limits.

## JSON and exit codes

- `--json` emits exactly one JSON document on stdout.
- Human text, warnings, and installer output go to the terminal or stderr.
- No command prompts in JSON mode.
- `install`, `uninstall`, `trace`, and tracked `update <tool>` require `--yes` in JSON mode or exit `5`.
- Noninteractive install and tracked update also require `--yes` outside JSON mode. Bare `tret update` explicitly requests self-update.
- Ordinary URL/selector invocations reject unknown commands/options and extra selectors with exit `2` before external execution or cleanup. Flags may precede or follow a selector.
- Curl/wget pastes keep downloader options and pipe text as data; known Tret options still apply. Put Tret options before the paste to keep the boundary clear.
- `help --json` and `--version --json` emit one document; help does not check for updates.

```bash
tret list --json | jq -r '.tools[].name'
tret inspect opencode --json | jq '.tool.actions'
```

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| `0`  | Success                                           |
| `1`  | Command failed                                    |
| `2`  | Bad command line (missing or malformed argument)  |
| `3`  | No tracked install matched the selector           |
| `4`  | Several installs matched; select one by record id |
| `5`  | Missing consent or blocked/unverified scope       |

## Run logs

- Every run except `--version` writes a log under `~/.tret/logs/`.
- Logs record the command line and user-facing output.
- Logs are owner-only and pruned to 50 files or 14 days.
- Credential masking is best-effort; do not put secrets in arguments.

## Development

| Command             | Purpose                                 |
| ------------------- | --------------------------------------- |
| `bun run dev`       | Run the CLI from source                 |
| `bun run build`     | Build every release target into `dist/` |
| `bun run test`      | Run tests                               |
| `bun run typecheck` | Type-check with `tsc --noEmit`          |
| `bun run lint`      | Run ESLint                              |
| `bun run format`    | Format with Prettier                    |

- `bun run build` compiles `{darwin,linux}-{arm64,x64}`, packages archives, and writes `dist/checksums.txt`.
- Linux builds also compile the experimental `tret-fanotify` helper for explicit development use. The CLI never selects it automatically.
- `bash scripts/build.sh <os>-<arch>` builds one target.
- `scripts/install.test.sh` exercises the install script against the built archive.
- Run the full verification suite before tagging a release.

## License

[Apache License 2.0](LICENSE)
