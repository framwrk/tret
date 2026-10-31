# Linux capture fidelity spike (2026-10-26)

**Status:** research complete; no capture or trace behavior changed.

This document is the written result of step 5 in `.agents/plans/next-up-ordering.md`. It measures
what the shipped Linux backend actually records, separates verified behavior from code/kernel
inference, and evaluates the two mechanisms the rewrite plan had left unspiked: eBPF tracepoints and
userns + overlayfs. The decisions it supports are **D13–D15** in `docs/capture/plan.md`.

The short version:

> Under the kernel's default Yama setting (used by Ubuntu, Arch and openSUSE), the unprivileged
> `strace` backend cannot attach in production, so an install falls back to the heuristic scanner.
> Under root, the fanotify helper reports directory-entry events against the **parent directory**
> because it never requests a directory FID or a name and never sets `FAN_ONDIR`; as shipped it can
> falsely own a parent directory and miss the file it was supposed to own. The only usable
> unprivileged attributed configuration is `ptrace_scope=0` with a compatible `strace`, and it still
> has the gaps listed below. Neither eBPF nor overlayfs should become the next backend before those
> shipped-path gaps are fixed.

## How this was measured

This host is macOS, has no Linux VM, and the spike was explicitly run without downloading a Linux
image. The measurement therefore combines the real-kernel evidence the project already produces in
CI with hermetic and synthetic checks that exercise the shipped code path.

| Evidence                                                                                                           | What it proves                                                                     | Result                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| CI run [`40426724090`](https://github.com/framwrk/tret/actions/runs/40426724090), job `linux-x64` (`121934216555`) | Real kernel + real `strace`, parent-mode tracer, representative installer          | 518 pass / 1 skip / 0 fail; `linux real-strace smoke` passed in 262 ms; `privileged-e2e.sh` passed |
| `bun test src/lib/capture/linux` on this macOS host                                                                | Shipped parser, reconstruction, normalization, fixture integration and conformance | 58 pass / 2 skip / 0 fail                                                                          |
| Synthetic traces through the shipped `parseStraceOutput` → `reconstruct` → `normalizeJournal`                      | Implementation behavior for cases the committed tests do not cover                 | Results in "Probe results" below                                                                   |
| Code audit of `src/lib/capture/linux/**` and `helper/tret-fanotify.c`                                              | What the backend can and cannot emit                                               | Findings F1–F13                                                                                    |
| Kernel and man-page contracts                                                                                      | fanotify, Yama, overlayfs and eBPF limits                                          | Sources at the end                                                                                 |

**Limits of this measurement.** No fanotify helper was executed on a kernel, and the production
`strace -p` attach path was not run on Linux (the CI smoke test runs the installer _under_ strace
instead). Those two are exactly where the largest gaps are, so they are called out as inferred from
code plus kernel contract rather than as measured end-to-end behavior.

## What actually runs

Backend selection is `defaultTracerFactory` in `src/lib/capture/linux/backend.ts`; install passes
`pid: process.pid`, so the tracer must attach to Tret itself while the installer runs as its child.

| Environment                                                                     | Selected backend                           | Reported completeness              | Reality                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Unprivileged, `kernel.yama.ptrace_scope=0`, compatible `strace` installed       | `linux-strace`                             | `complete` when no loss/diagnostic | The reference path; subject to F6–F12                                                                  |
| Unprivileged, `ptrace_scope>=1` (Ubuntu, Arch, openSUSE and the kernel default) | `macos-heuristic` via the install fallback | `heuristic`                        | `strace` is refused up front because a child cannot trace its parent; the scoped snapshot runs instead |
| Unprivileged, no `strace` on `PATH`                                             | `macos-heuristic` via the install fallback | `heuristic`                        | `selectDefaultTracer` throws before the installer runs                                                 |
| Root and `tret-fanotify` beside the binary (release archive layout)             | `linux-fanotify`                           | may report `complete`              | Dirent attribution is wrong as shipped (F1–F3)                                                         |
| Root, no helper found                                                           | `linux-strace`                             | as above                           | Root attach is permitted                                                                               |
| `--no-capture`, or both backends fail to start                                  | legacy snapshot/diff                       | legacy/heuristic                   | No journal; added paths are fingerprinted at record time, while mutation/deletion stays detect-only |

Two consequences worth stating plainly:

- The privileged end-to-end test in CI runs `dist/tret-linux-x64`, where the helper is named
  `dist/tret-fanotify-linux-x64`. `fanotifyHelperPath` looks for `tret-fanotify` **beside the binary**
  or in `~/.tret/bin`, so the test actually selects root `strace`, not fanotify. The only real-kernel
  test never exercises the helper. The packaged archive does place `tret-fanotify` beside `tret`, so
  release users get the helper and the behavior below.
- On a default Ubuntu host, an unprivileged install is recorded by the macOS-named heuristic scanner
  with `capture.backend: "macos-heuristic"`. It is labelled honestly as `heuristic`, but it is not
  the "first-class Linux backend" the coverage document describes, and its fallback roots drop
  `/usr/bin` and `/opt`.

## Accuracy matrix

Legend: **✅** correct effect; **◐** detected/partial but not fully correct or not restorable;
**▲** silent gap or wrong effect while the journal may still say `complete`; **n/a** not applicable.

The fanotify column describes the helper **as shipped**, not a corrected helper.

| Operation / condition                     | Expected record effect            | `linux-strace` (ideal attach)                             | `linux-fanotify` (shipped)                   |
| ----------------------------------------- | --------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| Create file + write                       | owned file                        | ✅                                                        | ▲ parent `mkdir`, file only a mutation       |
| Create empty file (`touch`)               | owned file                        | ✅                                                        | ▲ parent `mkdir`, file missing               |
| Overwrite existing file                   | mutation; restorable with backups | ◐ no before-image by default                              | ✅ (duplicate write events)                  |
| Unlink existing file                      | deleted entry                     | ✅                                                        | ▲ parent reported deleted                    |
| Rename within roots                       | source removal + destination      | ✅                                                        | ▲ parent→parent no-op or wrong parent rename |
| Rename over existing destination          | mutation with prior destination   | ◐ destination treated as created                          | ▲                                            |
| Create then delete                        | cancels out                       | ✅                                                        | ▲                                            |
| `mkdir` / `rmdir`                         | owned/removed directory           | ✅                                                        | ▲ `FAN_ONDIR` absent: no event               |
| Symlink create                            | owned symlink + target            | ✅                                                        | ▲ parent `mkdir`                             |
| `chmod`                                   | mutation with prior mode          | ◐ mode captured, prior mode lost                          | ◐ child `ATTRIB`, prior mode lost            |
| `chown` / xattr change                    | partial / explicit unsupported    | ◐ reported partial                                        | ▲ folded into `chmod`; not represented       |
| Hard link                                 | partial / explicit unsupported    | ◐                                                         | ▲                                            |
| `mmap` content write                      | partial / explicit unsupported    | ◐ if the mapping call is seen                             | ▲ never reported                             |
| Cross-root rename (e.g. `/tmp` → `$HOME`) | in-root half recorded             | ▲ whole record dropped                                    | ▲                                            |
| `openat2` create                          | owned file                        | ▲ create hint lost; file becomes a mutation or disappears | ▲ same dirent/child bug                      |
| uid transition (`setuid` exec)            | coverage loss reported            | ◐ tracer detaches, partial                                | ✅ fanotify is PID-based                     |
| Daemon outlives window                    | partial + live-descendant reason  | ◐                                                         | ▲ reparented process silently filtered       |
| fanotify queue overflow                   | partial                           | n/a                                                       | ◐ `@loss` reported                           |
| Remote change on network FS               | gap reported                      | ▲ no syscall, no flag                                     | ▲ kernel does not report it                  |
| Unrelated background churn                | not attributed                    | ✅ PID-scoped                                             | ✅ descendant-filtered                       |
| `io_uring` file operations                | gap reported                      | ▲ no per-operation syscall                                | ◐/▲ filesystem-event dependent               |
| Case-sensitive paths                      | case-correct ownership            | ✅ D10                                                    | ✅ D10                                       |

Counted over the table, `strace` is correct in 9 of 22 rows, partial in 8, silently wrong in 4 (one
row is n/a); fanotify as shipped is correct in 4, partial in 3, and silently wrong in 15. The counts
are a communication device, not a statistical score; the rows and findings are the evidence.

## Probe results

These were produced by feeding the shipped parser, reconstruction and normalization synthetic
records. They confirm implementation behavior; they are not kernel results.

| Probe                                                                       | Result                                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `openat2(..., {flags=O_CREAT}, ...)` then `write`                           | Journal `complete`; file appears as `mutated`, never `owned`. Uninstall will not remove it.                          |
| `openat2(..., {flags=O_CREAT}, ...)` with no write                          | Journal `complete`; no event, no entry. Empty created files disappear.                                               |
| `write(99, ...)` with no `-y` annotation and no known fd                    | No record, **no diagnostic**, journal `complete`. Contradicts the documented "unknown fd lowers completeness" claim. |
| Rename temp → pre-existing destination, destination never otherwise touched | Destination becomes `owned`; its prior content is not recorded and cannot be restored even with backups.             |
| `chmod` a pre-existing file with backups enabled                            | Mutation `{ path }` only: no prior mode, no hash, no blob. The baseline mode is ignored.                             |
| `link()` hard link                                                          | `partial` with an explicit unsupported reason; no invented entry. Correct policy.                                    |
| Rename `/tmp/stage/tool` → `$HOME/.local/bin/tool`                          | Whole record dropped, no diagnostic, journal `complete`. The installed file is not recorded.                         |
| Rename `$HOME/.local/bin/tool` → `/tmp/trash/tool`                          | Whole record dropped; the in-root removal is not recorded.                                                           |

## Findings

### F1 — fanotify dirent events resolve to the parent directory (critical)

The helper initializes fanotify with `FAN_CLASS_NOTIF | FAN_REPORT_FID` and does not request
`FAN_REPORT_DIR_FID`, `FAN_REPORT_NAME`, `FAN_REPORT_DFID_NAME` or `FAN_REPORT_TARGET_FID`
(`helper/tret-fanotify.c:262`). The kernel contract is explicit: without `FAN_REPORT_TARGET_FID`,
`FAN_CREATE`, `FAN_DELETE`, `FAN_MOVE` and `FAN_RENAME` report the **modified directory's** FID, not
the child's (`fs/notify/fanotify/fanotify.c`: "FS_CREATE reports the modified dir fid without
FAN_REPORT_TARGET_FID"). `resolve_handle()` therefore resolves the parent path.

The helper then branches on the parent path:

- `FAN_CREATE`: `stat(parent)` says directory, so it emits `mkdir(parent)`;
- `FAN_DELETE`: emits `unlink(parent)`;
- `FAN_MOVED_FROM`/`FAN_MOVED_TO`: pairs parent paths and emits `rename(parent, parent)` (or renames
  between two parent directories).

The child's `FAN_MODIFY`, `FAN_CLOSE_WRITE` and `FAN_ATTRIB` events do carry the child FID, so an
installer that creates and writes `~/.local/bin/tool` produces:

1. `mkdir(~/.local/bin)` — false ownership of an existing directory;
2. `write(~/.local/bin/tool)` — a mutation with no create event, so normalization cannot call it
   owned and uninstall will not remove the binary.

This makes the "high-fidelity" privileged backend unsafe for the ownership decision. `touch`-style
empty files and symlinks produce no file entry at all; deletes can record the parent directory as
deleted; moves are lost or corrupt two parent directories. Fix direction: use
`FAN_REPORT_DFID_NAME` (parent FID + name; Linux 5.9+) and `FAN_ONDIR`, construct dirent paths from
parent + name instead of opening the deleted/moved child, and fall back to strace on kernels older
than the required flags. `FAN_REPORT_TARGET_FID` (5.17+) is useful for child metadata but not required
for the path.

### F2 — fanotify does not report directory objects

The mark mask omits `FAN_ONDIR` (`helper/tret-fanotify.c:246`). fanotify(7): "Reporting events on
directories requires setting this flag in the mark mask." Directory creation, removal and rename are
therefore invisible, even before F1 is considered. This also means a record can own a directory only
by accident (through the parent bug above), never through the directory's own event.

### F3 — fanotify silently misses metadata, mmap and remote changes

- `FAN_ATTRIB` covers every metadata change, but the helper treats it as `chmod` and emits only the
  current mode. A `chown`, xattr or timestamp-only change produces a `chmod` event with no prior
  mode; normalization either records a non-restorable mode mutation or drops it when it already
  tracked the same mode. The metadata change itself is never represented, and no loss reason is
  emitted, so the journal can still say `complete`.
- fanotify does not report mmap/msync modifications or remote changes on network filesystems
  (fanotify(7) "Limitations and caveats"). The helper emits no loss reason for either.
- `FAN_CLOSE_WRITE` is emitted for a writable open even when nothing was written. Treating it as a
  write means an O_WRONLY open-and-close with no modification can appear as a mutation when backups
  are off.

### F4 — fanotify attribution is racy and loses reparented descendants

`is_descendant()` walks `/proc/<pid>/stat` parent links at event-read time. A process that
double-forks and reparents to init before the event is read is silently filtered out; a process that
has already exited is also filtered out because `/proc/<pid>` is gone. Neither case emits `@loss`.
The helper's FIFO move pairing (no rename cookie) can mispair concurrent renames from different
processes. Both are unobservable in the current conformance test, which replays a synthetic stream.

### F5 — unprivileged `strace` cannot attach on the default Yama setting

Production runs `strace -f -p <tret pid>` from a child process. Under `ptrace_scope=1`, an
unprivileged child may not attach to its parent. The kernel default is `1`; Ubuntu, Arch and openSUSE
adopt it (Fedora and Debian ship an `elfutils` override that sets `0`). `selectDefaultTracer()`
detects this and throws before installing, so `install` falls back to the heuristic scanner:
`capture.backend: "macos-heuristic"`, `completeness: "heuristic"`. This is safe and honest, but it
means the attributed Linux backend is unavailable on the most common default configuration.

Fix options (each needs its own plan): run the installer _under_ `strace` (tracer as parent) instead
of attaching to Tret; or have Tret declare the tracer with `PR_SET_PTRACER` (requires a native
helper or a different process arrangement); or document `ptrace_scope=0` as a requirement and stop
describing the unprivileged path as the default. The smoke test does not cover production attach
mode, so CI cannot catch a regression here.

### F6 — the strace trace set is fragile across distros

`STRACE_TRACE_SET` includes `fchmodat2`, which strace only decodes since 6.5 (the syscall is Linux
6.5). Older strace rejects the whole `-e trace=` set when any name is unknown, so every attach fails
and installs fall back to heuristic. Debian 12 (strace 6.1), Ubuntu 22.04 (strace 5.16) and other LTS
hosts are in this bucket. `openat2` has a similar, older cutoff. The current smoke test only runs on
`ubuntu-latest`, so it cannot catch this.

The parser also recognizes unsupported syscalls the tracer never requests: `msync`, `splice`,
`lremovexattr`, `fremovexattr` and `utimensat` are in the parser's unsupported set but absent from
the trace set, so those effects are silently ignored instead of lowering completeness. `mmap2` is a
32-bit-only name, and `sendfile64`/`mkfifoat` are not syscall names on the supported 64-bit targets,
so their presence in the parser set is harmless.

### F7 — cross-root renames are dropped whole

The parser filters each path against the observe roots before emitting a rename record. If either
side is outside, the entire record is dropped, no diagnostic is added, and completeness stays
`complete` (probe results). Installers commonly stage in `/tmp` or `$TMPDIR` and rename into
`$HOME`; `/tmp` is not an observation root (`installObservationRoots` contains only the platform
table and `$HOME`). The installed file is then missing from the record, and the reverse move misses
an in-root removal. The integration fixture adds its scratch directory to the roots, which masks the
production shape.

### F8 — `openat2` create hints are discarded

`openat2` flags live in a struct; the parser sets flags to empty. A create+write becomes a
non-restorable mutation (probe), an empty create disappears (probe), and an O_TRUNC-only overwrite
can be missed entirely. The known-limitations text claiming "the existence baseline still classifies
it" is not what the code does: reconstruction only classifies an `open` when `created` or `truncated`
is set, or the path already existed and is being tracked.

### F9 — rename-overwrite loses the destination's prior state

`reconstruct` gives a rename the source's before-state and the destination's after-state. It never
consults the baseline for the destination, and normalization treats an unknown destination as
created (`to.initial = null`). Renaming a temp file over an existing config therefore produces an
`owned` entry, not a mutation, and the old destination bytes are not restorable even with backups.
The unit test that covers "rename over a known destination" only works because it injects an earlier
write event for the destination, which a real `mv` does not produce.

### F10 — chmod records no prior mode

The reconstruction chmod event carries only the post-chmod mode. With backups enabled, the baseline
has the prior mode but it is not attached, so normalization emits a mutation with no `beforeHash`,
no `beforeBlob` and no original mode. The change is detected but cannot be restored. The uninstall
planner reports it as `detected` (non-blocking), not as a restore.

### F11 — unresolved file descriptors are dropped silently

The coverage document says an unresolved write fd becomes a diagnostic and lowers completeness. In
the shipped code, `emitWrite` returns without a record when `resolveFd` fails, and no diagnostic is
added (probe). In practice `-y` annotates regular files, so this is mostly a documentation/coverage
claim problem, but it is a real silent-drop path for anything strace cannot annotate.

### F12 — `io_uring` and `mprotect` are invisible

There is no syscall per io_uring operation; the installer can create and modify files without any
traced write/open/unlink syscall. `mprotect` is not traced either, so a read-only shared mapping that
is later made writable is not detected as an mmap gap. Both leave the journal eligible for
`complete`.

### F13 — no real-kernel fanotify test exists

The conformance test proves the strace-style and fanotify-style adapters normalize the same supplied
stream identically. It does not run the C helper. The privileged end-to-end test selects root strace
because of the helper filename mismatch described above. As a result F1–F4 have never been exercised
by CI, and the archived helper is the least-tested part of the Linux backend.

## Candidate mechanisms

### eBPF tracepoints

Two designs are possible: syscall tracepoints (`sys_enter_*`/`sys_exit_*`, portable names but raw
register arguments) or `fentry`/`fexit` on VFS functions (`vfs_create`, `vfs_unlink`, `vfs_rename`,
`vfs_setxattr`, `vfs_link`, ...). The latter is semantic and architecture-neutral but needs BTF and
CO-RE; `fentry` starts at Linux 5.5 and `CAP_BPF`/`CAP_PERFMON` split at 5.8. Unprivileged BPF is
disabled by default on hardened kernels (`unprivileged_bpf_disabled` can default to 2), and
`perf_event_paranoid` gates tracepoint attachment, so this is a root-or-capability path in practice,
the same gate as fanotify.

| Concern                    | Does eBPF fix it?                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mmap/msync content writes  | No operation-level visibility; could report `msync`/`mmap` as partial, like strace. A final content diff would reintroduce a scan.                             |
| xattr / ownership changes  | Yes at the event level (`setxattr`, `chown`, or VFS hooks), but the v3 record cannot represent them. Requires a record-format plan, not just a tracer.         |
| Hard links                 | Yes at the event level (`linkat`/`vfs_link`), same record-format limit.                                                                                        |
| uid transitions            | Yes: BPF observes tasks regardless of dumpability, unlike ptrace. Filter by pid map or cgroup id.                                                              |
| Daemonized descendants     | Yes if filtered by cgroup/pid map; still bounded by the window.                                                                                                |
| Network-filesystem changes | Local VFS operations visible; remote changes still unseen.                                                                                                     |
| `io_uring` operations      | Syscall tracepoints see only `io_uring_enter`; VFS hooks see the actual file operations.                                                                       |
| Portability / packaging    | Worse than fanotify: BTF-enabled kernel, per-arch CO-RE object, libbpf or raw `bpf()` loader, seccomp/lockdown/container caveats, and a higher minimum kernel. |

**Verdict: defer.** It has no advantage over fanotify at the same privilege except full syscall
arguments and uid-transition robustness, and those do not help until the shipped fanotify dirent bug
is fixed and the record can represent ownership/xattr/hard-link data. Revisit only with a v4 record
plan, a supported-kernel floor, and a real-installer demand case.

### userns + overlayfs (`bwrap`, `fuse-overlayfs`)

This runs the installer inside a user namespace with a writable overlay upper layer. It is an
execution sandbox, not an observer: there is no PID attribution, the overlay upper is a final-state
diff, and the install environment is changed.

Unprivileged overlayfs mounting in a user namespace landed in Linux 5.11 with the `userxattr` option;
the upper filesystem must support the required xattrs and `d_type` (NFS is unsuitable). Availability
is not portable: Ubuntu 24.04+ restricts unprivileged user namespaces with AppArmor by default
(`kernel.apparmor_restrict_unprivileged_userns=1`), Debian-derived kernels have
`kernel.unprivileged_userns_clone`, and `user.max_user_namespaces` can be zero. `bwrap` requires the
user namespace and sets `no_new_privs`, so setuid helpers and `sudo` inside the sandbox do not gain
host privileges.

| Concern                   | Does overlayfs fix it?                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mmap content writes       | Yes, if the write reaches the overlay; the upper layer holds the final bytes. No per-operation event or order.                                                        |
| xattr / ownership changes | Final metadata is in the upper, but the record still cannot represent it, and ids are namespaced. No before/after event.                                              |
| Hard links                | Final tree can preserve upper hard links; no link semantics in a v3 record.                                                                                           |
| uid transitions           | Namespaced root is the caller on the host; real host-root operations are impossible. This does not fix privileged installs; it makes them fail or behave differently. |
| Daemonized descendants    | The sandbox tears down when its init exits; a detached daemon is killed or loses its mount namespace. Behavior changes instead of being recorded.                     |
| Network filesystem        | Upper must be local and xattr-capable; network lowers are limited.                                                                                                    |
| Record shape              | Needs a final-state diff (overlay upper vs lower), not the event journal the rest of the pipeline consumes.                                                           |

**Verdict: reject as a capture backend.** It could be an explicit opt-in `--sandbox` install mode
later (with consent and a clear "this changes the install environment" warning), but it cannot be the
transparent default and it does not solve attribution.

## Follow-ups (no code in this spike)

Ordered by risk; each larger item needs its own plan.

1. **Stop trusting fanotify dirent records.** Either repair the helper (DFID_NAME + `FAN_ONDIR`,
   parent+name path construction, loss on unclassifiable events) or do not select fanotify until it
   has a real-kernel test. Until repaired, a fanotify record's `complete` label can mean `proven`
   (D11) while the ownership set is wrong.
2. **Make or document unprivileged attach.** Run the installer under strace, add `PR_SET_PTRACER`,
   or state the `ptrace_scope=0` requirement and keep the heuristic fallback visible. Add a Linux CI
   test for production attach mode on both `ptrace_scope` settings.
3. **Preserve the in-root half of cross-root renames** (create/delete plus a partial reason), or
   document and default-observe the installer's TMPDIR without turning `/tmp` into a global scan.
4. **Fix `openat2` flag decoding, rename-overwrite destination baselines, and chmod prior-mode
   capture.** These are contained changes to the strace parser/reconstruction.
5. **Make the trace set distro-safe:** probe or omit `fchmodat2`/`openat2`, and either trace the
   parser's unsupported syscalls (`msync`, `splice`, xattr removals, `utimensat`) or remove the
   parser-only claims.
6. **Add a real-kernel fidelity matrix to CI:** root fanotify using the packaged archive layout,
   unprivileged attach on `ptrace_scope` 0 and 1, cross-root rename, `openat2`, mmap write, xattr,
   hard link, uid transition and a reparented daemon. Assert both the record effects and the
   absence of false parent ownership.
7. **Revisit eBPF/overlayfs only after 1–6.** The current evidence does not justify a new backend.

## Reproduce

```
bun test src/lib/capture/linux        # parser, reconstruction, backend, fixtures, conformance
bun test                              # full suite; the real-strace smoke test is Linux-only
bun run lint
bun run typecheck
```

The synthetic probes can be reproduced by feeding the syscall lines listed in "Probe results"
through `parseStraceOutput` with `roots: ["/h"]`, a `FakeFsInspector`, `MemoryBaseline`, then
`reconstruct` and `normalizeJournal`. The two skipped local tests are the Linux-only real-strace
smoke and the environment-dependent default-tracer preflight.

## Sources

- fanotify(7), including `FAN_ONDIR` and the mmap/network limitations:
  <https://man7.org/linux/man-pages/man7/fanotify.7.html>
- `fanotify_init(2)`, `FAN_REPORT_FID`/`FAN_REPORT_DFID_NAME`/`FAN_REPORT_TARGET_FID` semantics:
  <https://manpages.ubuntu.com/manpages/stonking/man2/fanotify_init.2.html>
- Kernel `fanotify_report_child_fid`/`fanotify_fid_inode` comments (dirent events report the
  modified directory without `FAN_REPORT_TARGET_FID`):
  <https://github.com/torvalds/linux/blob/master/fs/notify/fanotify/fanotify.c>
- Yama `ptrace_scope` semantics: <https://docs.kernel.org/admin-guide/LSM/Yama.html>
- Distribution defaults (kernel default 1; Fedora/Debian `elfutils` override to 0):
  <https://www.fedoraproject.org/wiki/Changes/Restrict_ptrace_by_default>
- `unprivileged_bpf_disabled` values and default:
  <https://docs.kernel.org/admin-guide/sysctl/kernel.html#unprivileged-bpf-disabled>
- eBPF program types and `fentry`/`fexit` since 5.5: <https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_TRACING/>
- eBPF capability requirements: <https://docs.ebpf.io/linux/concepts/token>
- strace 6.5 release notes (first `fchmodat2` decoding): <https://github.com/strace/strace/releases/tag/v6.5>
- Overlayfs user xattr / unprivileged mounting:
  <https://docs.kernel.org/filesystems/overlayfs.html>
- Unprivileged overlayfs in 5.11:
  <https://github.com/torvalds/linux/commit/92dbc9dedccb9759c7f9f2f0ae6242396376988f>
- `bwrap(1)` overlay options and namespace requirements:
  <https://manpages.debian.org/testing/bubblewrap/bwrap.1.en.html>
- Ubuntu 24.04 AppArmor unprivileged-userns restriction:
  <https://gitlab.com/apparmor/apparmor/-/wikis/unprivileged_userns_restriction>
