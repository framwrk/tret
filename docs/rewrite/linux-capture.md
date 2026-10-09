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

## Mechanisms

Two tracers sit behind the same `LinuxTracer` seam (`src/lib/capture/linux/tracer.ts`); either can
produce the journal shape consumed by `reconstruct.ts` and `normalizeJournal`.

| Tracer                                    | `record.capture.backend` | Privilege                      | Default                |
| ----------------------------------------- | ------------------------ | ------------------------------ | ---------------------- |
| `StraceTracer` (`strace -f`)              | `linux-strace`           | unprivileged (same-uid ptrace) | yes                    |
| `FanotifyTracer` (`tret-fanotify` helper) | `linux-fanotify`         | `CAP_SYS_ADMIN` / root         | only when already root |

`defaultTracerFactory` selects fanotify only when the process already holds root (`getuid() == 0`)
**and** `$TRET_FANOTIFY` points at a present helper; otherwise it uses strace. Tret never escalates
with `sudo` on the user's behalf (D8). Running under `sudo` is the user's choice, and the record
carries `privilege: "root"` for sudo-aware uninstall.

The strace tracer is the zero-privilege, same-uid mechanism required by D7. `strace -f` follows
`fork`/`vfork`/`clone`, double-fork and `setsid` descendants because ptrace tracks tracees directly,
not by parentage, so daemonization does not by itself drop coverage. The fanotify helper
(`helper/tret-fanotify.c`) is the high-fidelity alternative for installs already running as root; it
is built at packaging time and is not compiled by `bun test`.

## What is captured

For the installer process tree and only for the bounded install window, the backend reports events
for:

- creates (`open`/`openat`/`creat` with `O_CREAT`, `mkdir`);
- writes (`write`/`pwrite`/`writev`, `truncate`/`ftruncate`, and fanotify `FAN_MODIFY`/`FAN_CLOSE_WRITE`);
- renames (`rename`/`renameat`/`renameat2`, fanotify `FAN_MOVED_FROM`/`FAN_MOVED_TO` paired);
- unlinks (`unlink`/`unlinkat`, fanotify `FAN_DELETE`);
- chmods (`chmod`/`fchmod`/`fchmodat`, fanotify `FAN_ATTRIB`);
- symlinks (`symlink`/`symlinkat`), recorded by target and never followed;
- directory creation and removal (`mkdir`/`mkdirat`, `rmdir`, `unlinkat(AT_REMOVEDIR)`).

Only paths under the `roots` passed to `start()` are attributed. This is defense in depth over the
tracer's own PID scoping, and it is what keeps unrelated background churn out of the journal: the
strace tracer only sees tracees' syscalls, and any record for a path outside the observe roots is
dropped by the parser and again by reconstruction. The integration fixture deliberately traces a
file **outside** the roots and asserts it is not attributed.

## Descendant tracking and how it ends

- **Scope.** The traced tree is the installer pid plus every process it forks, for as long as ptrace
  keeps them traceable. This is not limited to direct children.
- **Natural end.** When every tracee exits, `strace -f` exits; the journal is eligible to be
  `complete`.
- **Bounded window.** `stop()` waits a short settle period for the tracer to detach. If the tracer is
  **still attached to live tracees** when the window closes, a descendant (a daemon, a `setsid` child,
  or a process that reparented to init) outlived the install window. Its later activity is not
  captured, so the journal is marked `partial` with "live descendants".
- **Daemonized children.** A double-fork/`setsid` daemon is followed while it remains a tracee; it is
  only lost at the bounded-window boundary or a uid transition, and either case is reported.
- **uid transitions.** A `setuid`/`setgid` `execve` makes the process non-dumpable; an unprivileged
  tracer is detached and coverage stops. `strace` diagnostics mentioning `setuid`/`ptrace`/attach
  failures are folded into `partialReason`.
- **Relative paths.** strace does not report a tracee's working directory. `StraceTracer` resolves
  paths relative to a `cwd` option (install integration passes the installer's cwd); when a relative
  path cannot be resolved it is dropped and becomes a diagnostic, which marks the journal `partial`
  rather than guessing.
- **Inherited fds.** `strace -y` annotates descriptors with their paths, so a `write` resolves to a
  path without a prior `open` in the journal. A write on an fd the tracer cannot resolve is a
  diagnostic and lowers completeness.

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

The `docs/rewrite/contracts.md` diagnostic codes are reused end to end: `coverage` (from
normalization reading `completeness`), `unsupported`, `temp-rename`, `rename`, `create-delete`.

## Completeness rules

`Journal.completeness` is `"complete"` **only** when all of these hold; otherwise it is `"partial"`
with a `partialReason` joining every cause:

1. no tracer loss reason (attach denied, ptrace/setuid drop, fanotify helper error/overflow);
2. no unsupported syscall was observed;
3. no parser diagnostic (unresolved relative path, unknown fd, unfinished syscall);
4. the tracer detached on its own before the settle deadline (the whole tree exited).

A record is never labelled `complete` when any of 1–4 fails, so uninstall and `tret list` can trust
the label. `heuristic` is reserved for the macOS fallback; the Linux backend never emits it.

## Before-images

Reconstruction runs after the window and inspects final filesystem state. It records content hashes
only when bytes were actually read; a path that no longer exists (a temp file, an unlink, a rename
source) falls back to existence/kind. Because an overwrite destroys the prior bytes before a
post-hoc tracer can read them, the strace backend records mutations without a before-image unless a
scoped baseline or a future entry-stop tracer supplies one. The macOS heuristic fallback captures
before-image bytes at window start when backups are enabled (`--backup`); the Linux backend does not
yet, so a `--backup` install on Linux stays detect-only and `normalizeJournal` treats the missing
`before` as "detectable, not restorable" rather than inventing one.

The existence baseline (`captureBaseline`) walks the observe roots once and stores path → kind only.
It reads no file content, so it cannot become the global content diff the rewrite replaces; it exists
solely to tell a create from an overwrite and to describe a removed node's kind.

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
temp-rename and create-delete diagnostics. `linux.conformance.test.ts` feeds one shared record stream
through the unprivileged and privileged backends and asserts identical normalized effects.
`strace.test.ts` covers syscall parsing, path resolution, scope filtering and unsupported syscalls;
`reconstruct.test.ts` covers event→effect conversion; `backend.test.ts` covers completeness.

Run everything with:

```
bun test
bun run lint
```

The fixture scripts require only POSIX `sh` and execute no network or privileged operations.

## Known limitations

- Fanotify requires `CAP_SYS_ADMIN`; its helper is not built by `bun test` and is exercised through
  the double. Its move pairing is FIFO within a read buffer because fanotify exposes no rename
  cookie.
- `openat2` flags live in a struct the parser does not decode, so a create via `openat2` is reported
  as an open without the create hint; the existence baseline still classifies it.
- A relative path needs a known working directory; install integration must pass one.
- Memory-mapped and network-filesystem writes are blind spots and are reported as `partial`, never
  hidden.
- `mmap` tracing is file-filtered to shared writable mappings; anonymous mappings do not affect
  completeness.
