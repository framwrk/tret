<div align="center">

# Tret

**Install and uninstall CLI tools with verified ownership.**

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
- `tret update <tool>` — re-run that tool's recorded installer.
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
| `--force`                  | `install`, `uninstall`                    | Allow known fingerprint mismatches; uninstall also bypasses shared owners |
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
- `install` prints the URL, script hash, preview, and asks for consent unless `--yes` or `--json`.
- A failed installer keeps a partial record of observed changes.
- A no-executable install keeps a partial record and exits non-zero.
- `trace` runs the real tool, so it also asks for consent.
- `inspect` is read-only.

## Uninstall

- `tret uninstall <tool>` removes only files whose fingerprints still match.
- `tret uninstall <tool> --dry-run` prints the plan.
- `tret uninstall <tool> --yes` skips confirmation.
- `tret unclaim <tool> <path>` resolves a `shared-owner` conflict without `--force`.
- `tret forget <tool>` stops tracking a tool without deleting files.

### Shared paths

- Two records claiming one path block uninstall until resolved.
- `unclaim` changes no files and leaves the remaining record untouched.
- `unclaim` refuses paths the record does not claim or paths only that record claims.
- Delegated-removal overlaps always block, even with `--force`.

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
| Linux    | `linux-strace`, then `linux-heuristic` fallback, root `linux-fanotify` | `ptrace_scope=1` forces the heuristic fallback for unprivileged runs |

- Capture covers bounded observation roots under `$HOME`; `--observe` and `--observe-exclude` adjust them.
- Backups store only files at or below the per-file limit.
- With backups off, mutations and deletions are detect-only.
- `complete` means the tracer observed the full process tree with no known blind spot; otherwise the window is `partial`.
- Known Linux gaps: cross-root renames, `openat2` creates, mmap writes, xattr/ownership changes, and hard links.
- Root fanotify records are not proof of ownership while its directory-entry capture is under repair.
- macOS change detection is stamp-based and can miss edits that preserve size, mtime, and inode.

### Trust boundary

- Installers and traced tools run with your user privileges.
- Tret observes and records changes; it does not sandbox or prevent malware.
- Tret never escalates to `sudo` on its own.
- Use HTTPS sources you trust.

## JSON and exit codes

- `--json` emits exactly one JSON document on stdout.
- Human text, warnings, and installer output go to the terminal or stderr.
- No command prompts in JSON mode.
- `uninstall` and `trace` require `--yes` or exit `5`.

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
| `5`  | Refused without consent or force                  |

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
- Linux builds also compile the privileged `tret-fanotify` helper.
- `bash scripts/build.sh <os>-<arch>` builds one target.
- `scripts/install.test.sh` exercises the install script against the built archive.
- Run the full verification suite before tagging a release.

## License

[Apache License 2.0](LICENSE)
