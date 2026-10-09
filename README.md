<div align="center">

# Tret

**A CLI tool that installs other CLI tools and remembers what their install scripts changed, so you can remove them cleanly later.**

[![Release](https://img.shields.io/github/v/release/framwrk/tret?sort=semver&label=release)](https://github.com/framwrk/tret/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64-black.svg)](#how-it-works)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-f472b6.svg)](https://bun.sh)

[How it works](#how-it-works) · [Install](#install-tret) · [Usage](#usage) · [Development](#development) · [License](#license)

</div>

## How it works

When you install a tool with Tret, it:

1. Snapshots `~/`, `/opt/homebrew/bin`, and `/usr/local/bin` before the installer runs.
2. Fetches the install script at the URL you give and runs it inside a bounded capture window.
3. Closes the window and reports when it was open and how completely it covered the installer's process tree.
4. Snapshots the same paths again, diffs the two snapshots, and saves what the script added, edited, or deleted as a record for that tool, with the script's SHA-256 hash.

Records live in `~/.tret/records.json`. Nothing is backed up: Tret stores paths, not file contents.

Tret never runs the tool it just installed. Files a tool writes the first time you run it are not captured automatically; records reserve a segment for a later explicit trace (see [`docs/rewrite/lazy-writes.md`](docs/rewrite/lazy-writes.md)).

## Install tret

```bash
curl -fsSL https://tret.framwrk.com/scripts/install.sh | bash
```

The script installs the binary to `~/.tret/bin/tret` and adds that directory to your PATH. It never asks for a password.

Tret supports macOS on Apple Silicon only. To remove the Tret binary itself, run `curl -fsSL https://tret.framwrk.com/scripts/uninstall.sh | bash` (the script asks for confirmation).

## Usage

| Command                                          | Purpose                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `tret install <URL>` (`add`)                     | Run the install script in a bounded capture window, then record what it changed |
| `tret uninstall <tool_name>` (`remove`, `unadd`) | Remove the files the tool's install added                                       |
| `tret list` (`show`)                             | List every tool installed with Tret                                             |

`install` also takes `--force`: it uninstalls the tool first, then reinstalls it from a clean diff. Anything after `--` passes to the install script itself (`tret install <URL> -- --skip-browser`). `install` attaches a capture backend to the install window by default; `--no-capture` runs the installer without it. `uninstall` takes `--dry-run` to preview the removal and `--yes` to skip the confirmation prompt.

### Install a tool

```bash
tret install https://example.com/install.sh
```

Tret derives the tool's name from the executable the install puts on disk — the file in a `bin` folder it ranks first, otherwise the first executable it added. The tool's own installer output passes through to your terminal. If the installer exits with an error, Tret records nothing.

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

Uninstall removes the files the install added and strips the tool's PATH lines from your shell config. It asks for confirmation first. Files the installer edited (an appended line in `~/.zshrc`, for example) stay in place, and Tret prints them as a log. Tret is not a restore tool: it never puts deleted or edited files back.

### List installed tools

```bash
tret list
```

Each row shows the tool's name, URL, install date, executable path, the script's hash, and how many files the install added or edited.

## Development

| Command          | Purpose                            |
| ---------------- | ---------------------------------- |
| `bun run dev`    | Run the CLI from source            |
| `bun run build`  | Compile to `dist/tret-macos-arm64` |
| `bun run test`   | Run tests (`bun test`)             |
| `bun run lint`   | Run ESLint                         |
| `bun run format` | Format with Prettier               |

Tret is written in TypeScript and runs on [Bun](https://bun.sh), compiled to a single binary. The layout is small by design: `index.ts` routes commands, `src/commands/<command>.ts` holds one function per command, and `src/lib/` holds the snapshot, diff, capture-session, and record logic. `examples/` contains reference install scripts only.

## License

[Apache License 2.0](LICENSE)
