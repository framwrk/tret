<div align="center">

# Tret

**A CLI tool that installs other CLI tools.**

[![Release](https://img.shields.io/github/v/release/framwrk/tret?sort=semver&label=release)](https://github.com/framwrk/tret/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20arm64%2Fx64-black.svg)](#platform-support)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-f472b6.svg)](https://bun.sh)

[Install](#install) · [Uninstall](#uninstall) · [Usage](#usage) · [Development](#development) · [License](#license)

</div>

## Install

```bash
curl -fsSL https://tret.framwrk.com/scripts/install.sh | bash
```

The script uses the latest release, picks the archive for your OS and CPU, verifies it against `checksums.txt`, extracts the binary to `~/.tret/bin/tret`, and links it as `~/.local/bin/tret`.

### Update

Tret can update itself in place. `tret update` re-runs the published install script. To update a tool Tret installed rather than Tret itself, run `tret update <tool_name>`.

```bash
tret update
```

```bash
curl -fsSL https://tret.framwrk.com/scripts/install.sh | bash
```

### Platform support

| OS    | Architectures  |
| ----- | -------------- |
| macOS | `arm64`, `x64` |
| Linux | `arm64`, `x64` |

⚠️ Windows systems are not supported.

## Uninstall

To remove the Tret binary itself, run `curl -fsSL https://tret.framwrk.com/scripts/uninstall.sh | bash` (the script asks for confirmation).

### Manual Uninstall

Run `tret list` to see which tools are currently installed with Tret. Then run these steps in order:

1. Remove the `tret` symlink.

   ```bash
   rm ~/.local/bin/tret
   ```

2. Remove the binary:

   ```bash
   rm ~/.tret/bin/tret
   ```

3. Remove Tret's data: the records file, before-image backups in `~/.tret/objects/`, and the update-check cache:

   ```bash
   rm -rf ~/.tret
   ```

## Usage

| Command                                          | Purpose                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tret install <URL>` (`add`)                     | Fetch the install script at the URL, run it in a bounded capture window, then record what it changed                                      |
| `tret uninstall <tool_name>` (`remove`, `unadd`) | Remove the files the tool's install owns, after verifying their fingerprints                                                              |
| `tret list` (`show`)                             | List every tool installed with Tret, with its capture completeness and whether it is still installed                                      |
| `tret inspect <tool_name>`                       | Show what Tret recorded for a tool without changing anything: capture confidence, owned paths, changed files, and what uninstall would do |
| `tret trace <tool_name>`                         | Run a tracked tool in a bounded observation window and append what it writes to the record (asks first)                                   |
| `tret find <tool_name>`                          | Adopt an already-installed command and record the files it owns                                                                           |
| `tret forget <tool_name>`                        | Stop tracking a tool without touching its files                                                                                           |
| `tret update [tool_name]`                        | Update Tret to the latest release; with a tool name, re-run that tool's recorded installer                                                |

- `install --force`: fetch and validate the replacement script, then uninstall the tool and reinstall it from a clean capture.
- `install --no-capture`: run the installer without a capture window.
- `install --backup`: save before-images so overwritten or deleted files can be restored on uninstall.
- `install --observe <path>`: also observe this absolute path in the install's capture window, for an installer that writes outside the default roots (repeatable).
- `install --observe-exclude <path>`: drop one of the default observation roots for this install (repeatable; a path another remaining root still covers stays observed).
- `install --name <name>`: record the tool under this display name instead of the installed command's basename.
- `install <URL> -- <args>`: anything after `--` goes to the install script (`tret install <URL> -- --skip-browser`).
- `install --yes`: skip the installer confirmation prompt.
- `uninstall --dry-run`: preview the removal without changing anything.
- `uninstall --force`: allow removing files or symlinks with a known fingerprint mismatch already present when planning, and bypass shared-owner conflicts.
- `uninstall --yes`: skip the confirmation prompt.
- `trace --yes`: skip the confirmation prompt before running the traced tool.
- `update --yes`: skip the confirmation prompt when re-running a tracked tool's installer.
- `--json` (global): write one JSON document to stdout instead of human text; supported by `list`, `inspect`, `trace`, `forget`, `uninstall`, and `update`.

### Install a tool

```bash
tret install https://example.com/install.sh
```

```bash
tret install
```

Tret gets the tool's name from the executable that the installer puts on disk. The file in a `bin` folder is ranked first, otherwise the first executable it added. The tool's own installer output passes through to your terminal. If the installer exits non-zero after producing a discoverable executable, Tret keeps a partial record rather than silently undoing anything, and tells you how to inspect or remove the changes.

For `install --force`, a failed download leaves the current install and its record untouched. Once the old install has been removed, Tret does not roll it back: if the replacement exits non-zero or creates no discoverable executable, Tret saves a partial recovery record under the old tool name with the changes the capture observed. A no-executable record is shown as `partial` with no binary. Use `tret list` to inspect it and `tret uninstall <name>` to remove its recorded changes. Recovery is limited to observed changes; only before-images captured with `--backup` can be restored.

Each install runs inside a bounded capture window. Tret prints a line describing it: the backend, whether coverage is `complete`, `partial`, or `heuristic`, the window's start and end, and how many events and roots were observed.

Before it runs, Tret prints the installer's URL, its SHA-256, and a short preview of the script. When you run interactively it asks you to confirm; `--yes` skips that prompt, and `--json` never prompts. Tret observes and records what the installer changes so you can remove it later. It does not sandbox the installer or prevent malware: the installer runs with your privileges and can do anything you can. Tret's protection is being able to see and undo what it recorded, not blocking the change first.

You can also paste the install command as it appears on the tool's site:

```bash
tret install curl -fsSL https://example.com/install.sh | bash
```

### Uninstall a tool

Run `tret uninstall <tool_name>` to remove a tool's files. By default, a file is removed only while its recorded content hash matches, and a symlink only while its recorded target matches; divergent paths are kept. Plans whose records cannot prove ownership (`partial` or `heuristic` capture, including tools adopted by `find`) are labeled: Tret notes that the paths are observed, not proven to belong to the tool, and marks each `remove`/`restore` as `(observed, not proven)`. The label describes the evidence, not a weaker removal rule — the same fingerprint checks still decide what may change. `--force` may remove an owned file or symlink when both fingerprints are known but already mismatch at planning time, and may bypass shared-owner conflicts. It does not make a missing or unreadable fingerprint removable or override a kind change. Each planned `remove` or `restore` action carries the state captured by the plan and is checked again immediately before it is applied, after confirmation. If that state changes between planning and apply, the path is kept even with `--force`; run uninstall again to review the new state. Ordinary shared-path conflicts block until you pass `--force`; delegated-removal overlaps always block, including with `--force`. Uninstall asks for confirmation first; use `--dry-run` to preview the plan or `--yes` to skip the prompt. To stop tracking a tool without touching its files, use `tret forget <tool_name>`.

### List installed tools

```bash
tret list
```

Each row shows the tool's name, URL, install date, a `State` column (`installed` when the tracked executable is still on disk, `partial` when it is gone), the executable path, the script's hash, how many files the install owns, and the capture completeness (see below). A `partial` row shows `-` for the binary rather than a stale path.

### Inspect a tool

```bash
tret inspect opencode
```

Inspect is read-only: it changes no files and no records. It shows the record's capture confidence and observation window, the executable it tracks and whether it is still on disk, the paths Tret believes it owns, the files changed since install and whether they can be restored, and the actions `uninstall` would take. Use it to decide whether a tool is safe to remove before running `uninstall`. Pass a display name or a record id; when several records share a name, `inspect` lists them by id instead of guessing. Add `--json` for a machine-readable document.

### Trace a tool

```bash
tret trace opencode
```

`trace` runs one tracked tool inside a bounded observation window and appends what it writes to the record as a separate segment. It asks before running the tool, because it executes the real program; pass `--yes` to skip the prompt. A path another record already claims is reported and skipped, so a trace never takes ownership away from another tool, and the install's original window is left unchanged. Tracing is opt-in and never runs a tool silently.

### Update a tracked tool

```bash
tret update opencode
```

With a tool name or record id, `update` re-runs that record's installer URL with the arguments it was originally installed with, keeping the same record id and display name. Tret downloads and validates the replacement script before it removes the working install, so a failed download or validation leaves the current install untouched; a failure while replacing it leaves a reduced record so `uninstall` can still clean up. A bare `tret update` updates Tret itself.

### JSON output and exit codes

`--json` makes a command write exactly one JSON document to stdout and route all human text, warnings, and installer output to the terminal or stderr, so a piped run stays valid JSON. It is supported by `list`, `inspect`, `trace`, `forget`, `uninstall`, and `update`.

```bash
tret list --json | jq -r '.tools[].name'
tret inspect opencode --json | jq '.tool.actions'
```

No command prompts in JSON mode. A run that would need confirmation fails with a structured error and exit code `5`; pass `--yes` when a script needs the action to proceed.

Exit codes are stable for automation:

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | The command succeeded                                      |
| `1`  | The command failed                                         |
| `2`  | The command line was wrong (missing or malformed argument) |
| `3`  | No tracked install matched the selector                    |
| `4`  | Several tracked installs matched; select one by record id  |
| `5`  | The command refused to proceed without consent or force    |

A selector is a display name or a record id. A name shared by several records fails and lists the ids to choose from.

### Run logs

Every command except the fast-path `--version` check writes a per-run log under `~/.tret/logs/`. It records the command line and Tret's user-facing output; failed runs may also include a short tail of installer output. Logs are created with owner-only file permissions and pruned to 50 files or 14 days. Tret masks common credential patterns, but redaction is not exhaustive: avoid putting secrets in command arguments or installer output.

## Development

| Command          | Purpose                                 |
| ---------------- | --------------------------------------- |
| `bun run dev`    | Run the CLI from source                 |
| `bun run build`  | Build every release target into `dist/` |
| `bun run test`   | Run tests (`bun test`)                  |
| `bun run lint`   | Run ESLint                              |
| `bun run format` | Format with Prettier                    |

`bun run build` runs `scripts/build.sh`, which compiles `{darwin,linux}-{arm64,x64}` with `bun build --compile`, packages each as `tret-<os>-<arch>.tar.gz`, and writes `dist/checksums.txt`. Linux targets also compile the privileged `tret-fanotify` capture helper into the archive (a cross-build from a non-Linux host skips it with a warning). `bash scripts/build.sh <os>-<arch>` builds a single target. CI builds and tests every target on a native runner, and `scripts/install.test.sh` exercises the install script against the built archive without touching the network.

Tret is written in TypeScript and runs on [Bun](https://bun.sh), compiled to a single binary. The layout is small by design: `index.ts` routes commands, `src/commands/<command>.ts` holds one function per command, and `src/lib/` holds the capture, record, and update logic. `examples/` contains reference install scripts only.

## License

[Apache License 2.0](LICENSE)
