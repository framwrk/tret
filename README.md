<div align="center">

# Tret

**A CLI tool that installs other CLI tools and remembers what their install scripts changed, so you can remove them cleanly later.**

[![Release](https://img.shields.io/github/v/release/framwrk/tret?sort=semver&label=release)](https://github.com/framwrk/tret/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20arm64%2Fx64-black.svg)](#platform-support)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-f472b6.svg)](https://bun.sh)

[How it works](#how-it-works) · [Install](#install-tret) · [Usage](#usage) · [Capture completeness](#capture-completeness-and-labels) · [Backups](#backups-and-privacy) · [Recovery](#recovery-and-safe-uninstall) · [Limits](#unsupported-cases-and-limits) · [Development](#development)

</div>

## How it works

When you install a tool with Tret, it:

1. Starts an install-scoped capture of filesystem changes (a journal where the platform can provide one, a scoped snapshot otherwise).
2. Fetches the install script at the URL you give and runs it inside a bounded capture window.
3. Normalizes what the installer and its descendants changed into owned files, mutations, and deletions, with a SHA-256 content hash for each path.
4. Saves that record, together with the script's hash and the capture's completeness, in `~/.tret/records.json`.

Records separate **ownership** (files the install created) from **mutation** (files it overwrote) and **deletion**, so uninstall can act on evidence instead of guessing from names. Records live in `~/.tret/records.json`.

## Platform support

Tret ships as a release archive per OS and architecture. The published matrix is `tret-{darwin,linux}-{arm64,x64}.tar.gz`, with a `checksums.txt` covering every archive and raw binary.

| OS    | Architectures  | Capture backend                                  | Typical completeness |
| ----- | -------------- | ------------------------------------------------ | -------------------- |
| macOS | `arm64`, `x64` | Scoped snapshots plus content hashes (no tracer) | `heuristic`          |
| Linux | `arm64`, `x64` | Kernel/process tracing (`fanotify`, `ptrace`)    | `complete`/`partial` |

Windows and architectures other than `arm64`/`x64` are not supported. `scripts/install.sh` and the daily self-update check both select the running platform's archive and verify its SHA-256, so `tret update` works the same way everywhere.

Tret never runs the tool it just installed. Files a tool writes the first time you run it are not captured automatically; records reserve a segment for a later explicit trace (see [`docs/rewrite/lazy-writes.md`](docs/rewrite/lazy-writes.md)).

## Install tret

```bash
curl -fsSL https://tret.framwrk.com/scripts/install.sh | bash
```

The script resolves the newest release, picks the archive for your OS and CPU, verifies it against `checksums.txt` (using `shasum -a 256` on macOS and `sha256sum` on Linux), extracts the binary to `~/.tret/bin/tret`, and links it as `~/.local/bin/tret`. It never asks for a password, never writes to your shell rc files, and fails closed on a corrupted download.

Tret updates itself in place: `tret update` re-runs the published install script, which skips the download when your binary already matches the release checksum.

To remove the Tret binary itself, run `curl -fsSL https://tret.framwrk.com/scripts/uninstall.sh | bash` (the script asks for confirmation).

## Usage

| Command                                          | Purpose                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `tret install <URL>` (`add`)                     | Fetch the install script at the URL, run it in a bounded capture window, then record what it changed |
| `tret uninstall <tool_name>` (`remove`, `unadd`) | Remove the files the tool's install owns, after verifying their fingerprints                         |
| `tret list` (`show`)                             | List every tool installed with Tret, with its capture completeness                                   |
| `tret find <tool_name>`                          | Adopt an already-installed command and record the files it owns                                      |
| `tret update`                                    | Update Tret to the latest release                                                                    |

`install` also takes `--force` (uninstall the tool first, then reinstall it from a clean capture) and `--no-capture` (run the installer without attaching a capture window). Anything after `--` passes to the install script itself (`tret install <URL> -- --skip-browser`). `uninstall` takes `--dry-run` to preview the removal and `--yes` to skip the confirmation prompt.

### Install a tool

```bash
tret install https://example.com/install.sh
```

Tret derives the tool's name from the executable the install puts on disk — the file in a `bin` folder it ranks first, otherwise the first executable it added. The tool's own installer output passes through to your terminal. If the installer exits non-zero, Tret keeps a **partial** record rather than silently undoing anything, and tells you how to inspect or remove the changes.

Each install runs inside a bounded capture window, and Tret prints a line describing it: the backend, whether coverage is `complete`, `partial`, or `heuristic`, the window's start and end, and how many events and roots were observed.

The paste form works too:

```bash
tret install curl -fsSL https://example.com/install.sh | bash
```

### Capture and lazy writes

Tret observes the install window only. It does not invoke the installed tool (no implicit `--help` run), so files a command writes the first time you run it are outside the record. Capture completeness is always reported:

- **complete** — a tracer observed the installer's whole process tree.
- **partial** — a tracer attached but lost coverage (a `sudo` transition, a daemonized process). The reason is printed.
- **heuristic** — no process attribution (macOS has no unprivileged tracer); changes are inferred from scoped snapshots and labeled as such.

A later explicit `tret trace` will run a tool under the same bounded session and attach its window as a new record segment without a format migration; it is deferred for now (decision D5).

### Uninstall a tool

```bash
tret uninstall <tool_name>
```

Uninstall removes only files whose recorded fingerprint still matches, restores a mutated or deleted file only when a before-image exists and the current state still matches the record, and preserves anything that diverged. It strips the tool's PATH lines from shell config only when it can attribute those edits to the install, asks for confirmation first, and prints every remove, restore, skip, and conflict. Use `--dry-run` to see the plan without changing anything.

### List installed tools

```bash
tret list
```

Each row shows the tool's name, URL, install date, executable path, the script's hash, how many files the install owns, and the capture completeness (see below).

## Capture completeness and labels

Every record carries a `capture.backend` and a `capture.completeness` label, and Tret shows the label wherever it could otherwise overstate its knowledge:

- **`complete`** — a journal or tracer observed the install's process tree end to end, so attribution is proven rather than inferred.
- **`partial`** — the installer escalated privileges, daemonized, or otherwise escaped the observed tree; some changes may be unattributed, and Tret says so.
- **`heuristic`** — no tracer was available, so Tret compared scoped snapshots and content hashes. Attribution is inferred and may miss detached processes or background churn.

Linux provides the complete/partial tiers through kernel and process tracing. macOS has no unprivileged, process-attributing tracer, so it always reports `heuristic`; Tret never claims completeness the backend cannot prove. The record format is backend-neutral, so a future opt-in tracer can produce the same records without a migration.

## Backups and privacy

Tret stores paths and content **hashes** by default; it does **not** copy file contents. Before-image blobs are **off by default**, because prior config files can contain secrets.

With backups disabled, a record still supports detection, verification, and logging, and is marked non-restorable. The storage layer implements a bounded, private, content-addressed opt-in (owner-only `~/.tret/objects/`, atomic writes, deduplication, a size limit, and reference-aware garbage collection), but `tret install` does not yet expose a flag or config for it, so restore is not reachable from the shipped commands.

Tret never silently restores over a file that changed after installation.

## Recovery and safe uninstall

Uninstall is evidence-based and conservative:

- An owned file is removed only if its installed fingerprint still matches; otherwise Tret keeps it and reports the conflict unless you explicitly force the action.
- Owned directories are removed only when empty after their owned descendants are handled; a shared tree is never recursively deleted because its parent was recorded.
- A mutation or deletion is restored only when a before-image exists and the current state still matches. Diverged state is preserved and reported.
- If two records claim the same path, Tret reports the conflict instead of transferring ownership or guessing from a matching filename. Passing `--force` removes this record's verified entry regardless.
- Incomplete cleanup keeps a partial record so a retry stays safe.

## Migration

Records are versioned. Opening an older (`v2`) records file migrates it to the current format in place, atomically, and never erases records on failure:

- Old `added` paths become legacy ownership entries.
- Old `edited` paths become legacy mutations.
- Migrated records are marked legacy/heuristic with unknown hashes and no before-images, so uninstall treats them as detect-only and never fabricates restore capability.

Existing `find` records and their URL/hash semantics are preserved.

## Unsupported cases and limits

- **OS/arch:** Windows and CPUs other than `arm64`/`x64` are unsupported; the install script and update check stop with a message.
- **macOS attribution:** without an Apple-granted tracer entitlement, Tret can only infer ownership from scoped snapshots, and reports `heuristic`.
- **Daemonized or privilege-escalated descendants:** a process that detaches or changes user during install can escape the capture window; Tret labels the record `partial` instead of `complete`.
- **Backup coverage:** files that exceed the size limit or cannot be read are recorded but not restorable; files written through `mmap` on some backends and changes on network filesystems may not appear in a journal.
- **Privileged installs:** Tret supports installers that use `sudo`, records the install's privilege, and makes uninstall sudo-aware for root-owned entries. It never escalates on your behalf.
- **Case sensitivity:** Tret probes each filesystem rather than assuming the macOS default, so ownership and collision checks stay correct on case-sensitive volumes.

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
