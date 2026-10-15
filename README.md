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

Tret can update itself in place. `tret update` re-runs the published install script.

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

| Command                                          | Purpose                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `tret install <URL>` (`add`)                     | Fetch the install script at the URL, run it in a bounded capture window, then record what it changed |
| `tret uninstall <tool_name>` (`remove`, `unadd`) | Remove the files the tool's install owns, after verifying their fingerprints                         |
| `tret list` (`show`)                             | List every tool installed with Tret, with its capture completeness and whether it is still installed |
| `tret find <tool_name>`                          | Adopt an already-installed command and record the files it owns                                      |
| `tret forget <tool_name>`                        | Stop tracking a tool without touching its files                                                      |
| `tret update`                                    | Update Tret to the latest release                                                                    |

- `install --force`: fetch and validate the replacement script, then uninstall the tool and reinstall it from a clean capture.
- `install --no-capture`: run the installer without a capture window.
- `install --backup`: save before-images so overwritten or deleted files can be restored on uninstall.
- `install <URL> -- <args>`: anything after `--` goes to the install script (`tret install <URL> -- --skip-browser`).
- `uninstall --dry-run`: preview the removal without changing anything.
- `uninstall --force`: allow removing files or symlinks with a known fingerprint mismatch already present when planning, and bypass shared-owner conflicts.
- `uninstall --yes`: skip the confirmation prompt.

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

`bun run build` runs `scripts/build.sh`, which compiles `{darwin,linux}-{arm64,x64}` with `bun build --compile`, packages each as `tret-<os>-<arch>.tar.gz`, and writes `dist/checksums.txt`. `bash scripts/build.sh <os>-<arch>` builds a single target. CI builds and tests every target on a native runner, and `scripts/install.test.sh` exercises the install script against the built archive without touching the network.

Tret is written in TypeScript and runs on [Bun](https://bun.sh), compiled to a single binary. The layout is small by design: `index.ts` routes commands, `src/commands/<command>.ts` holds one function per command, and `src/lib/` holds the capture, record, and update logic. `examples/` contains reference install scripts only.

## License

[Apache License 2.0](LICENSE)
