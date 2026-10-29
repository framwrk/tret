# Linux capture backend (Phase 4)

This document is the coverage contract for `src/lib/capture/linux/`, the first-class Linux
`CaptureBackend` from the rewrite plan (section 8, decisions D7 and D8). It records what the backend
observes, where it cannot observe, and how completeness is decided. It is the reference backend used
to validate journal normalization independently of macOS constraints.

The module implements the frozen `CaptureBackend` contract in `src/lib/capture/backend.ts`:

```
start({ pid, privilege, roots }) -> CaptureSession
CaptureSession.stop()            -> Journal { backend, completeness, partialReason?, events }
```

> **Fidelity status (2026-10-26):** the measured accuracy of this backend, including the shipped
> fanotify helper's parent-directory misattribution and the default-Yama attach gap, is documented in
> `docs/capture/linux-fidelity.md` (plan decisions D13–D15). The sections below describe intended
> behavior and call out the known deviations; where the two disagree, the fidelity document wins.

## Mechanisms

Two tracers sit behind the same `LinuxTracer` seam (`src/lib/capture/linux/tracer.ts`); either can
produce the journal shape consumed by `reconstruct.ts` and `normalizeJournal`.

| Tracer                                    | `record.capture.backend` | Privilege                      | Default                |
| ----------------------------------------- | ------------------------ | ------------------------------ | ---------------------- |
| `StraceTracer` (`strace -f`)              | `linux-strace`           | unprivileged (same-uid ptrace) | yes                    |
| `FanotifyTracer` (`tret-fanotify` helper) | `linux-fanotify`         | `CAP_SYS_ADMIN` / root         | only when already root |

`defaultTracerFactory` selects fanotify only when the process already holds root (`getuid() == 0`)
**and** a helper executable is present; otherwise it uses strace. The helper is found as
`$TRET_FANOTIFY` when that override is set, otherwise as `tret-fanotify` next to the running binary
(a release archive ships it beside `tret`), with `~/.tret/bin/tret-fanotify` as the fallback for a
dev run driving an installed release; a candidate must be an executable regular file. Tret never
escalates with `sudo` on the user's behalf (D8). Running under `sudo` is the user's choice, and the
record carries `privilege: "root"` for sudo-aware uninstall.

The strace tracer is the zero-privilege, same-uid mechanism required by D7. `strace -f` follows
`fork`/`vfork`/`clone`, double-fork and `setsid` descendants because ptrace tracks tracees directly,
not by parentage, so daemonization does not by itself drop coverage. The fanotify helper
(`helper/tret-fanotify.c`) is the privileged alternative for installs already running as root; it is
built at packaging time and is not compiled by `bun test`. Its shipped directory-entry attribution is
currently incorrect (see "Fanotify-specific limits" below), so it must not be described as
high-fidelity until that is repaired.

**Production attach caveat.** Install passes `pid: process.pid`, so the tracer must attach to Tret
while the installer runs as its child. Under the kernel-default Yama `ptrace_scope=1` (Ubuntu, Arch,
openSUSE), an unprivileged child may not attach to its parent; `parentAttachRestricted()` detects it
and `install` falls back to the labeled heuristic scanner (`capture.backend: "macos-heuristic"`).
The unprivileged `strace` backend therefore runs only when `ptrace_scope=0` or the process is root.
The real-strace smoke test runs the installer _under_ strace (parent mode), so it does not cover
production attach.

## What is captured

For the installer process tree and only for the bounded install window, the backend reports events
for:

- creates (`open`/`openat`/`creat` with `O_CREAT`, `mkdir`);
- writes (`write`/`pwrite`/`writev`, `truncate`/`ftruncate`, and fanotify `FAN_MODIFY`/`FAN_CLOSE_WRITE`);
- renames (`rename`/`renameat`/`renameat2`, fanotify `FAN_MOVED_FROM`/`FAN_MOVED_TO` paired);
- unlinks (`unlink`/`unlinkat`, fanotify `FAN_DELETE`);
- chmods (`chmod`/`fchmod`/`fchmodat`, fanotify `FAN_ATTRIB`);
- symlinks (`symlink`/`symlinkat`), recorded by the target string exactly as the tracee wrote it
  (relative, dangling, or pointing outside the roots) and never followed;
- directory creation and removal (`mkdir`/`mkdirat`, `rmdir`, `unlinkat(AT_REMOVEDIR)`).

Only paths under the `roots` passed to `start()` are attributed. This is defense in depth over the
tracer's own PID scoping, and it is what keeps unrelated background churn out of the journal: the
strace tracer only sees tracees' syscalls, and any record for a path outside the observe roots is
dropped by the parser and again by reconstruction. The integration fixture deliberately traces a
file **outside** the roots and asserts it is not attributed.

An install window's roots include `$HOME` itself (`captureHomeRoot`), exactly like macOS, so a tool
that drops a dotfile or dot-directory outside the fixed XDG roots (`~/.pi`, `~/.toolrc`, `~/.bun`)
is captured instead of the install being unobservable. Attributing under that root stays consistent
with the existence baseline: the baseline walk records an excluded directory but never descends into
it, so reconstruction drops records whose ancestor directories match the shared skip rules
(`EXCLUDED_DIR_NAMES`/`EXCLUDED_DIR_NAME_PATTERN` — `node_modules`, caches, `dist`). A skipped
directory itself is still recorded; only its contents are out of scope. (The macOS scoped engine
applies name exclusions only to its `$HOME` root; the Linux baseline never walks excluded
directories under any root, so Linux applies them everywhere or a pre-existing file under one would
be misclassified as a create.)

`tret install --observe <path>` adds one absolute root to the window and `--observe-exclude <path>`
drops one of the table's default roots, for that one install only (D3 user additions/removals). The
parser drops records outside the resolved roots, so an added root is attributed and an excluded one
is not.

## Descendant tracking and how it ends

- **Scope.** The traced tree is the installer pid plus every process it forks, for as long as ptrace
  keeps them traceable. This is not limited to direct children.
- **Natural end.** When every tracee exits, `strace -f` exits; the journal is eligible to be
  `complete`.
- **Bounded window.** `stop()` waits a short settle period for the tracer to detach. In parent mode
  (`strace -p <caller>`) the tracer stays attached to the still-running root by construction, so the
  check is instead whether any _other_ recorded pid is still alive: if one is, a descendant (a
  daemon, a `setsid` child, or a process that reparented to init) outlived the install window. Its
  later activity is not captured, so the journal is marked `partial` with "live descendants". The
  probe is best-effort (`/proc/<pid>` exists): a descendant that issued no traced syscall never
  appears in the records, and a reused pid reads as alive.
- **Daemonized children.** A double-fork/`setsid` daemon is followed while it remains a tracee; it is
  only lost at the bounded-window boundary or a uid transition, and either case is reported.
- **uid transitions.** A `setuid`/`setgid` `execve` makes the process non-dumpable; an unprivileged
  tracer is detached and coverage stops. `strace` diagnostics mentioning `setuid`/`ptrace`/attach
  failures are folded into `partialReason`.
- **Relative paths.** strace reports syscall arguments as the tracee passed them. With `-y` it also
  annotates each dirfd, including `AT_FDCWD</dir>` — the tracee's working directory at that syscall —
  so `StraceTracer` resolves a relative path against the annotated directory first (this is what
  makes `mkdir -p`'s component-by-component `mkdirat(AT_FDCWD<...>, "name")` calls resolve
  correctly). Only an unannotated dirfd falls back to the `cwd` option (install integration passes
  the installer's cwd); a relative path with no known directory at all is dropped and becomes a
  diagnostic, which marks the journal `partial` rather than guessing.
- **Inherited fds.** `strace -y` annotates descriptors with their paths, so a `write` resolves to a
  path without a prior `open` in the journal. The shipped parser does **not** add a diagnostic when
  an fd cannot be resolved: `emitWrite` returns without a record and completeness is unchanged
  (fidelity finding F11). In practice `-y` annotates regular files; pipes/sockets and unusual
  descriptor shapes are silently out of scope.

## Fanotify-specific limits

These are properties of the shipped helper (`helper/tret-fanotify.c`), not of the shared journal:

- **Directory-entry events resolve to the parent.** The helper requests `FAN_REPORT_FID` only, not
  `FAN_REPORT_DFID_NAME`/`TARGET_FID`. The kernel reports the modified **directory** for
  `FAN_CREATE`/`FAN_DELETE`/`FAN_MOVED_*` without `FAN_REPORT_TARGET_FID`, so `resolve_handle()` returns
  the parent. A file create becomes `mkdir(parent)`, a delete becomes `unlink(parent)`, and a move is
  a parent→parent rename. The child's later `FAN_MODIFY` is recorded as a write, so a created file
  normalizes as a mutation rather than ownership and uninstall leaves it behind.
- **Directories are not reported.** The mark mask omits `FAN_ONDIR`, which fanotify requires before
  any directory create/delete/move event is generated.
- **Metadata changes collapse.** `FAN_ATTRIB` covers chmod, chown, xattrs and timestamps, but the
  helper emits only a `chmod` with the current mode. A chown/xattr/timestamp-only change is not
  represented: it may appear as a non-restorable mode mutation or be dropped once the mode is known,
  and no loss reason is emitted.
- **mmap and network changes are invisible.** fanotify does not report mmap/msync modifications or
  remote network-filesystem changes, and the helper emits no loss reason for either.
- **Attribution races.** `is_descendant()` reads `/proc/<pid>/stat` at event-read time. A reparented
  daemon or an already-exited process is silently filtered out; move pairing is FIFO and can mispair
  concurrent renames because fanotify has no rename cookie.
- **Queue overflow is reported.** `FAN_Q_OVERFLOW` becomes `@loss` and downgrades the journal to
  `partial`; `FAN_UNLIMITED_QUEUE` is not requested even when root.

The helper is not exercised by `bun test` or by the privileged CI check as currently laid out (the
check runs a `dist/` binary while the helper is named `dist/tret-fanotify-<target>`, so root `strace`
is selected). See `docs/capture/linux-fidelity.md` for the full evidence and the repair direction.

## Unsupported syscalls

The strace trace set includes syscalls whose effects a v3 record cannot represent. When one succeeds
it is reported as an `unsupported` diagnostic and the journal is downgraded to `partial`:

| Syscall(s)                                                | Why it is a gap                                    |
| --------------------------------------------------------- | -------------------------------------------------- |
| `mmap`/`mmap2` (`MAP_SHARED` + `PROT_WRITE`, file-backed) | memory-mapped content changes are not write events |
| `sendfile`/`copy_file_range`/`splice`                     | kernel-side copies bypass `write`                  |
| `fallocate`                                               | block allocation may change content                |
| `chown`/`lchown`/`fchown`/`fchownat`                      | ownership is not represented in a v3 record        |
| `setxattr`/`lsetxattr`/`fsetxattr`/`removexattr`          | extended attributes are not represented            |
| `mknod`/`mkfifo`/`link`/`linkat`                          | special files and hard links are not represented   |
| `utime`/`utimes`/`utimensat`                              | timestamp changes are not represented              |

Anonymous `mmap` allocations are filtered and do **not** lower completeness, so ordinary process
startup is not reported as partial. The fanotify helper cannot see mmap writes either and reports
queue overflow (`@loss`) as a separate reason.

**Trace-set coverage and compatibility gaps (2026-10-26):**

- The parser recognizes `msync`, `splice`, `lremovexattr`, `fremovexattr` and `utimensat`, but
  `STRACE_TRACE_SET` does not request them, so their effects are silently ignored instead of lowering
  completeness. `mprotect` is not traced, so a shared mapping made writable after a read-only `mmap`
  is also a silent mmap gap.
- `STRACE_TRACE_SET` requests `fchmodat2`, which strace only decodes from 6.5 (the syscall is Linux
  6.5). Older strace rejects the whole `-e trace=` set, so every attach fails and the install falls
  back to heuristic. Debian 12 (strace 6.1) and Ubuntu 22.04 (strace 5.16) are affected. The
  real-strace smoke test runs on `ubuntu-latest`, so it does not catch this.
- `io_uring` file operations issue no per-operation `open`/`write`/`unlink` syscall and are invisible
  to this tracer; the journal is still eligible for `complete`.

The `docs/capture/contracts.md` diagnostic codes are reused end to end: `coverage` (from
normalization reading `completeness`), `unsupported`, `temp-rename`, `rename`, `create-delete`.

## Completeness rules

`Journal.completeness` is `"complete"` **only** when all of these hold; otherwise it is `"partial"`
with a `partialReason` joining every cause:

1. no tracer loss reason (attach denied, ptrace/setuid drop, fanotify helper error/overflow);
2. no unsupported syscall was observed;
3. no parser diagnostic (unresolved relative path, unknown fd, unfinished syscall);
4. no reconstruction diagnostic: a path whose parent resolves outside the observe roots is dropped and downgrades the window, because the record cannot claim to cover an object it deliberately left unrecorded;
5. no descendant outlived the window: either the tracer detached on its own before the settle
   deadline, or every recorded pid other than the observed root was already gone. The root is the
   caller's own process — `strace -p <caller>` stays attached for as long as it runs — so its
   liveness alone does not lower coverage.

A record is never labelled `complete` when any of 1–5 fails, so the label is consistent with the
tracer's own reporting. `heuristic` is reserved for the macOS fallback; the Linux backend never emits
it.

**Caveat (2026-10-26):** rules 1–5 only cover what the tracer reports. The shipped fanotify helper
does not report directory-entry paths correctly (F1), omits `FAN_ONDIR` (F2), and silently ignores
chown/xattr/mmap/network changes (F3), so a `complete` fanotify journal can still be missing or
misattributing effects. D11's `proven` label must not be applied to such a record until the helper is
repaired and covered by a real-kernel test (D15).

## Before-images

Reconstruction runs after the window and inspects final filesystem state. It records content hashes
only when bytes were actually read; a path that no longer exists (a temp file, an unlink, a rename
source) falls back to existence/kind, or to the baseline metadata below.

Because an overwrite destroys the prior bytes before a post-hoc tracer can read them, before-images
are captured at window start. When `--backup` is enabled, the baseline walk reads each pre-existing
regular file that fits the backup size limit (1 MiB by default, or the limit `--backup-size <bytes>`
sets for that install; the flag requires `--backup`) once, keeps its bytes under their sha256 content
address, and stores the file's prior hash, size, mode, and mtime alongside its kind; reconstruction
attaches that metadata as the `before` of an overwrite, truncating open, unlink, or rename source,
so the record is restorable with its prior permission bits. Over-limit or unreadable files stay
kind-only: the change is still recorded, just not restorable. This mirrors the macOS heuristic
fallback's window-start capture (`docs/capture/macos-capture.md`).

With backups off (the default, D2) the baseline walk stays existence-only and reads no file content,
so it cannot become the global content diff this rewrite replaces; it exists solely to tell a create
from an overwrite and to describe a removed node's kind. `normalizeJournal` treats a missing
`before` as "detectable, not restorable" rather than inventing one, and `install` drops any restore
claim whose blob was not actually stored (`storeBeforeImages`), so a record never advertises a
restore `getBlob` cannot perform.

## Integration fixture

`src/lib/capture/linux/fixtures/` contains a hermetic end-to-end fixture:

- `fake-installer.sh` performs a deterministic install under `$TRET_FIXTURE_HOME` and
  `$TRET_FIXTURE_TMPDIR` and writes a matching strace trace to stdout;
- `fake-strace.sh` is a minimal `strace` double that satisfies `StraceTracer`'s argument shape and
  redirects the installer's trace output to the `-o` file;
- `fake-fanotify.sh` is a minimal `tret-fanotify` double that replays NDJSON records and can emit an
  `@loss` line.

`linux.integration.test.ts` runs the fake installer through the real `StraceTracer` spawn/parse
path, `reconstruct`, and `normalizeJournal`, and asserts ownership/mutation/deletion plus the
temp-rename and create-delete diagnostics. The fixture puts its scratch directory in the observe
roots; production does not observe `/tmp`, which is why the fixture does not expose the cross-root
rename loss (F7). `linux.conformance.test.ts` feeds one shared record stream through the
unprivileged and privileged backends and asserts identical normalized effects. `strace.test.ts`
covers syscall parsing, path resolution, scope filtering and unsupported syscalls;
`reconstruct.test.ts` covers event→effect conversion; `backend.test.ts` covers completeness.

`linux.smoke.test.ts` is the one test that runs **real** `strace` (Linux-only; it skips when `strace`
is absent). It runs a representative installer under `strace` as the tracer's own child — parent-mode
ptrace, which the kernel permits without elevated privileges under Yama — and drives the output
through the shipped parser, `reconstruct`, and the Linux backend, and asserts the window is labelled
`complete`. Two things only this test can catch: a trace-set name `strace` does not recognize (it
refuses the whole `-e trace=` set, so every attachment would fail and silently fall back) and parser
drift against genuine kernel output that would lower the label.

Run everything with:

```
bun test
bun run lint
```

The fixture scripts require only POSIX `sh` and execute no network or privileged operations.

## Known limitations

Measured details and evidence are in `docs/capture/linux-fidelity.md`; this list is the short
coverage contract.

- **Fanotify dirent attribution is wrong as shipped.** Without `FAN_REPORT_DFID_NAME`/`TARGET_FID`,
  create/delete/move events carry the parent directory FID; without `FAN_ONDIR`, directory events are
  not generated. See "Fanotify-specific limits" and F1–F2.
- **Fanotify silently misses metadata, mmap and network changes.** `FAN_ATTRIB` is reduced to chmod;
  chown/xattr/timestamp changes, mmap writes and remote network-filesystem changes are not reported
  and do not lower completeness. Reparented descendants are filtered out by the `/proc` ancestry
  check; FIFO move pairing can mispair concurrent renames. F3–F4.
- **Unprivileged production attach needs `ptrace_scope=0`.** With the kernel default `1`, install
  falls back to the heuristic scanner. F5.
- **The trace set is distro-sensitive.** `fchmodat2` requires strace 6.5+; older strace rejects the
  whole set. `msync`, `splice`, `lremovexattr`, `fremovexattr` and `utimensat` are recognized by the
  parser but not traced. F6.
- **Cross-root renames are dropped whole.** If either side is outside the observe roots, no record
  and no diagnostic is produced, and completeness can stay `complete`. `$TMPDIR`/`/tmp` is not an
  observe root by default. F7.
- **`openat2` flags are not decoded.** A create+write becomes a non-restorable mutation; an empty
  create disappears. F8.
- **Rename-overwrite loses the destination's prior state.** The destination is treated as created;
  restoration is not possible even with backups. F9.
- **chmod does not carry the prior mode.** The change is detected but not restorable. F10.
- **An unresolved write fd is dropped silently.** The parser does not add the diagnostic the previous
  text claimed. F11.
- **`io_uring` and `mprotect` are invisible.** Neither lowers completeness. F12.
- **Fanotify requires `CAP_SYS_ADMIN`**; its helper is not built by `bun test`, and the privileged CI
  check currently selects root `strace` rather than the helper. F13.
- A relative path needs a known working directory; install integration must pass one.
- The journal never claims a restore it cannot perform: where the tracer cannot see a change or lacks
  a before-image, the record stays detect-only rather than inventing one.
