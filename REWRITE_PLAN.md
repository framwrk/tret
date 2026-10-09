# Install recording rewrite plan

## Goal

Replace Tret's global before/after filesystem scan as the primary way to decide what an install owns. The rewritten mechanism should attribute changes to an install, retain enough evidence to make uninstall safe, and make its coverage limits visible instead of inferring ownership from names and broad filesystem heuristics.

Do this on a platform-neutral core so the same tool runs on macOS (arm64 and x64) and Linux (arm64 and x64). The record format, journal normalization, hashing, storage, and uninstall logic should be shared; only the capture backend and a small platform table of paths, shell configs, privilege policy, and release artifacts should differ per OS.

This file is a design and implementation plan; it does not change the current install or uninstall behavior by itself.

## Current behavior and motivation

Today `tret install` snapshots `$HOME` and `/usr/local/bin`, runs a downloaded script, and diffs the snapshots. `ToolRecord` keeps added and edited paths, but not deleted paths or file contents. This leads to several limitations the rewrite should address:

- A global diff cannot distinguish installer activity from unrelated background filesystem churn.
- Stamp comparisons (mtime, size, inode) are a heuristic for edits, not proof of changed contents.
- `runFirstRun()` runs the new executable with `--help` and takes another snapshot to try to capture lazy initialization.
- Exclusion rules and shared-directory guards compensate for the wide snapshot and uncertain ownership.
- Uninstall can remove additions, but edited and deleted files cannot be restored; ownership checks are partly reconstructed from path names.
- Reinstalling a URL replaces a name-keyed record, which does not describe shared-path or multi-tool ownership explicitly.

Relevant current code includes `src/commands/install.ts`, `src/lib/{snapshot,diff,installer,first-run,removal,records}.ts`, `src/lib/shellconfig.ts`, `src/constants.ts`, and `src/types.ts`.

Platform assumptions are also baked into code the current design does not isolate: `SNAPSHOT_ROOTS` (`src/constants.ts`), `SHARED_ABSOLUTE`/`SHARED_IN_HOME` (`src/lib/removal.ts`), `SEARCH_DIRS_IN_HOME` (`src/lib/related.ts`), `RC_FILES` (`src/lib/shellconfig.ts`), the hardcoded `tret-macos-arm64` artifact (`src/lib/updatecheck.ts`, `scripts/install.sh`), and the single build target in `package.json`. These must move behind a platform seam, or cross-platform support becomes a large later edit rather than a small one.

## Target design

### 1. Use an install-scoped change journal as the primary input

Define a backend-neutral event/journal interface for filesystem operations attributable to an install process tree. At minimum, investigate recording creates, writes, renames, unlinks, chmods, symlinks, and directory creation/removal. Preserve the operation sequence and enough before/after metadata to normalize it into final effects:

- A temporary file written and renamed over a destination should become a change to the destination, not a lasting temporary-file addition.
- A create followed by delete should normally cancel out of the final install result.
- An overwrite or deletion should retain the prior state when restoration is enabled.
- A rename should be represented as a source removal plus destination creation/replacement, with the relationship retained for diagnostics.

The journal should capture the installer and its descendants only for the install window. It must not imply that every daemonized or detached process is covered: define how descendant tracking ends, expose incomplete/unsupported coverage, and avoid claiming completeness where the backend cannot prove it.

### 2. Keep capture backends replaceable and be honest about macOS

Add a capture-backend boundary so record processing and uninstall do not depend on a particular OS mechanism. First investigate technically viable, unprivileged macOS process-tree capture methods and their blind spots. Do not make EndpointSecurity, DTrace, SIP changes, root access, or injection-based tracing an implicit requirement; each has entitlement, privilege, security, or coverage constraints.

If a complete unprivileged tracer is not feasible, ship a clearly labeled fallback rather than pretending the global scan is a journal. The fallback should use scoped snapshots of plausible install surfaces (for example tool-specific dot-directories, `.config`, `.local`, common shell config files, `/usr/local`, and selected `~/Library` subdirectories), compare content hashes when stamps differ, and report that attribution is heuristic. Retain a backend interface so a future opt-in tracer or another platform backend can produce the same record format.

The scope must be configurable or revisited using test fixtures and real installer examples; avoid a new sprawling exclusion list as a substitute for attribution. Keep platform limitations in CLI output and documentation.

### 3. Model effects and ownership explicitly

Replace the `added`/`edited`-only shape with a versioned record that separates ownership from mutation. A starting point:

```ts
type InstallRecord = {
  id: string;
  name: string;
  source: "install" | "find";
  url: string;
  installedAt: string;
  executable: AbsolutePath;
  scriptSha256: string;
  capture: { backend: string; completeness: "complete" | "partial" | "heuristic" };
  owned: Array<{ path: AbsolutePath; kind: "file" | "directory" | "symlink"; installedHash?: string }>;
  mutated: Array<{ path: AbsolutePath; beforeHash?: string; installedHash?: string; beforeBlob?: string }>;
  deleted: Array<{ path: AbsolutePath; beforeHash?: string; beforeBlob?: string }>;
};
```

Treat this as a direction, not a final API: settle stable IDs, symlink representation, directory manifests, and optional fields during implementation. Keep multiple records able to refer to the same path; make conflicts and shared ownership visible instead of silently assuming the latest record owns the whole path. Define how `tret find` adoption records differ from installs that have journal evidence.

### 4. Add content fingerprints and optional before-images

For files touched by a journal (and files in the scoped-snapshot fallback when their stamps indicate a change), compute a cryptographic content hash. Hashes should be the verification mechanism for uninstall, not mtime/size/inode alone. Record symlink targets and file type separately; do not follow symlinks by default.

Support content-addressed before-image blobs for overwritten or deleted files so restore is possible, subject to explicit safety controls:

- Store blobs under `~/.tret/objects/` with restrictive permissions and atomic writes.
- Make backup/restore policy explicit; provide an opt-in or clear consent because prior config files can contain secrets.
- Set a configurable size limit and a documented policy for files that exceed it or cannot be read. Continue to record the mutation without claiming it is restorable.
- Deduplicate by content hash and garbage-collect only blobs no record references.
- Never silently restore over a file changed after installation.

If backups are disabled, preserve useful before/after hashes and report that the record supports detection/logging but not restoration.

### 5. Keep lazy runtime changes explicit

Do not silently run arbitrary installed tools as the only way to discover their writes. Remove the implicit `--help` first-run behavior as a dependency of capture. If a capture backend can remain attached safely, define a bounded install session and how it handles the tool's first invocation. Otherwise provide an explicit command such as `tret trace <tool>` to record a later run as a new journal segment attached to that record. Clearly show the observation window and process-tree coverage.

### 6. Make uninstall evidence-based and conservative

Plan uninstall from the journal-derived record and verify current state before changing it:

- For an owned file, remove it only if its installed fingerprint still matches. If it has changed, keep it and explain the conflict unless the user explicitly chooses a force action.
- Remove owned directories only when empty after owned descendants are handled; never recursively delete an unverified shared tree merely because its parent was recorded.
- For a mutation or deletion, offer restoration only when a before-image exists and the current state still matches the recorded installed state (or remains absent for a recorded deletion).
- If the current state diverged, preserve it and report the conflict. Make dry-run describe every planned remove, restore, skip, and conflict.
- Keep shell configuration cleanup narrowly tied to paths/edits attributed to the install. Do not delete a user's later edits just because a line resembles an installer's PATH setup.
- Retain partial records when cleanup is incomplete so retry behavior remains safe.

Revisit the existing name-based `removeGuarded()` / tool-name pruning behavior. The intended model is to remove verified owned entries, not infer ownership from a matching basename. Keep broad-path protections as defense in depth.

### 7. Version and migrate the on-disk format

Bump the records format version. Implement an explicit migration from the current v2 `added`/`edited` records:

- Map old `added` paths to legacy ownership entries and old `edited` paths to non-restorable legacy mutations.
- Mark migrated records as legacy/heuristic with unknown hashes and no before-images; do not invent provenance or enable unsafe restoration.
- Preserve existing `find` source records and URL/hash semantics where present.
- Keep atomic writes, validate malformed records, and ensure a failed migration does not silently erase the user's records.

Document the migration and retain compatibility tests with representative current record files.

### 8. Target macOS and Linux from a shared core

Keep one platform-neutral core and isolate every OS-specific decision behind a small `Platform` abstraction plus the capture-backend boundary. The goal is that adding a platform is one new backend module and one platform table, not edits scattered across commands. Deliberately design this in phase 1-2 rather than porting later: if only the tracer is abstracted, the path tables below get duplicated and the "minimal edits" promise fails.

The platform layer should own:

- **Capture backend:** macOS and Linux differ sharply here, and Linux is the easier case. Prefer genuinely unprivileged mechanisms; Linux offers `fanotify` (`FAN_CLASS_NOTIF`), eBPF tracepoints, and `ptrace`, while macOS is limited by entitlements, root, SIP, and injection blind spots. Implement Linux as a first-class backend, not an afterthought, and use it as a reference to test the backend-neutral normalization independently of macOS constraints.
- **Scope and search roots:** replace `SNAPSHOT_ROOTS`, `SHARED_ABSOLUTE`/`SHARED_IN_HOME`, and `SEARCH_DIRS_IN_HOME` with per-OS tables. Linux needs `/usr/bin`, `/usr/local/bin`, `/opt`, `~/.local/{bin,share,lib,state}`, `~/.config`, XDG dirs, systemd user units (`~/.config/systemd/user`), desktop entries (`~/.local/share/applications`), and package-manager bin dirs such as `~/.cargo/bin`, in place of the `/Applications`/`~/Library` assumptions.
- **Shell config:** keep `RC_FILES` but make it per-OS and per-shell (add `.bash_login`, `/etc/profile.d`, fish, etc.), with detection that matches the shells actually present.
- **Privilege policy:** decide once, for both OSes, whether Tret refuses privileged installs or supports them. macOS currently installs only into user-writable directories with no sudo; Linux installers commonly `sudo` into `/usr/local/bin`, `/etc`, and systemd, which changes trace attribution, file ownership, and whether uninstall needs sudo. Make this an explicit policy surfaced in the record (`privilege: "user" | "root"`) rather than an implicit platform behavior.
- **Release artifacts and self-update:** replace the hardcoded `tret-macos-arm64` with an `os`/`arch` matrix (`tret-{darwin,linux}-{arm64,x64}`), a `uname -s`/`uname -m` mapping used by `scripts/install.sh` and `updatecheck.ts`, and a hashing tool that works on both (`shasum -a 256` on macOS, `sha256sum` on Linux). Update `package.json`/CI to build and publish every target.
- **Filesystem semantics:** do not assume the macOS default of case-insensitive, case-preserving paths. Make collision and ownership comparisons case-correct per filesystem (identify case sensitivity rather than hardcoding it), and account for symlink, xattr, `TMPDIR`, and copy-on-write/rename differences.

Records carry `capture.backend` and `capture.completeness`, so a macOS heuristic fallback and a Linux complete backend can coexist and remain distinguishable in `tret list` and uninstall output.

## Implementation sequence

1. **Requirements and spike:** inventory representative installers and test the candidate macOS and Linux capture techniques. Write down coverage, privilege, process-tree, rename, symlink, daemonization, and case-sensitivity limits per OS. Decide what is feasible before promising a tracing backend.
2. **Platform abstraction:** define the `Platform` seam (scope/search roots, shell configs, privilege policy, release artifact naming, filesystem case behavior) and the capture-backend interface together. Move the existing macOS-specific tables behind it so the core compiles and passes tests against both a macOS and a Linux platform table from the start.
3. **Data model and pure normalization:** define journal events, normalization rules, ownership/conflict semantics, hash and backup policy, and record v3. Implement/test the pure conversion from events to record effects.
4. **Capture backend:** implement the selected backend(s) behind the interface, starting with the Linux backend as the reference where it is easier, then macOS. Add an explicit heuristic fallback only if needed, with labeled coverage metadata and bounded scan scope.
5. **Install integration:** route install execution through the backend; preserve installer stdout/stderr behavior, script hashing, executable selection, privilege handling, and failure handling. Ensure failed or interrupted installs do not create misleading complete records; capture partial state where useful and label it.
6. **Storage and migration:** add content-addressed blob storage, atomic record/blob writes, permissions, size limits, reference cleanup, and v2-to-v3 migration.
7. **Safe uninstall:** implement fingerprint verification, restore/remove planning, conflicts, dry-run output, partial retry records, conservative directory cleanup, and sudo-aware handling for root-owned installs.
8. **Lazy-write workflow:** remove dependence on automatic `--help`; implement/document the chosen explicit trace or bounded-session behavior.
9. **Distribution, commands, docs, and rollout:** build and publish the `os`/`arch` artifact matrix, teach `scripts/install.sh` and the self-update check to select the running platform's artifact, update `install`, `uninstall`, `list`, and `find` as required, and document capture completeness, privacy/backup defaults, unsupported cases, migration, and recovery. Keep the legacy path available during validation if practical, then remove it only after parity and migration tests pass.

## Test and acceptance criteria

Add unit and integration coverage for at least:

- Create/write, overwrite, delete, rename-overwrite, symlink, chmod, temp-file, nested-directory, and create-then-delete sequences.
- Concurrent unrelated filesystem churn not attributed by a complete journal backend.
- Partial/unsupported tracing and daemonized descendants reported as incomplete rather than complete.
- Hash changes with preserved mtimes and unchanged files with noisy metadata.
- Shared paths, two records claiming one path, pre-existing files, paths replaced after installation, and directories containing user files.
- Backup deduplication, permissions, size limits, missing/corrupt blobs, restore conflicts, and reference-aware garbage collection.
- Dry-run equivalence with actual uninstall planning; interrupted/partial cleanup and retries.
- v2 migration, malformed records, atomic-write failure, and legacy records that must not be treated as restorable.
- Shell config lines appended, rewritten, and subsequently user-edited.
- First-run/lazy writes and explicit trace-session boundaries.
- Platform tables on macOS and Linux fixtures: scope/search roots, guards, shell configs, artifact selection, and filesystem case behavior (case-sensitive and case-insensitive).
- Privilege policy: root-owned install capture and sudo-aware uninstall, and rejection/warning behavior for privileged installs.
- Self-update and `scripts/install.sh` artifact selection across `{darwin,linux}` × `{arm64,x64}`.

The rewrite is ready to replace the current mechanism when:

1. A record distinguishes created, modified, and deleted paths and records capture completeness.
2. Uninstall verifies the installed state before removing or restoring anything and preserves diverged user data by default.
3. Backups, when enabled, are bounded, private, integrity-checked, and never silently overwrite later changes.
4. Existing records migrate without losing entries or gaining fabricated restore capability.
5. Tests demonstrate the documented capture coverage and the CLI clearly labels heuristic/partial results.
6. README usage and safety claims match the shipped behavior.
7. The shared core builds and passes its test suite against both a macOS and a Linux platform table, and adding a platform is confined to a backend module plus a platform table rather than edits across commands.

## Open decisions

- Which unprivileged macOS mechanism, if any, can provide useful process-tree attribution without unacceptable blind spots?
- Should backups default off with explicit opt-in, or on for small files with consent and a strict quota?
- Should fallback scope be curated fixed paths, user-configurable roots, or both?
- How should ownership conflicts be resolved in commands and data: shared references, conflict requiring user action, or explicit transfer?
- Should `tret trace` be part of the first rewrite or deferred until install-time capture is reliable?
- What is the policy for a script that exits non-zero after making changes: save a partial record, prompt to keep/undo it, or both?
- Which platform's backend is implemented first for reference: Linux (easier, unprivileged) or macOS (the primary current target)?
- Does Tret support privileged/`sudo` installs, or refuse them and require user-writable targets on every platform?
- Do self-update and install ship raw binaries per `os`/`arch`, or archives (for example `.tar.gz` on Linux), and how is the running artifact identified?
- How is filesystem case sensitivity determined per path (assume per-OS, probe the mount, or store a flag per record)?

## macOS capture feasibility

Phase 1 spike finding, per the plan's requirement to "investigate technically viable, unprivileged macOS process-tree capture methods." Each mechanism is judged on privileges, process-tree coverage, rename/unlink visibility, symlink handling, daemonized-descendant behavior, and failure modes. No kernel extensions and no Apple entitlements are assumed.

### macOS

| Mechanism | Privileges | Process-tree / attribution | Rename / unlink | Symlinks | Daemonized descendants | Failure modes |
| --- | --- | --- | --- | --- | --- | --- |
| EndpointSecurity | root **and** `com.apple.developer.endpoint-security.client` (request-only from Apple) **and** TCC approval | Full, per-event PID, kernel-level | Notify create/write/rename/unlink/setmode events | Event-level inode/path | Covered (not tied to parentage) | Cannot self-entitle; `ES_NEW_CLIENT_RESULT_ERR_NOT_ENTITLED` / `..._ERR_NOT_PRIVILEGED`; distribution-gated |
| DTrace / `fs_usage` / `dtruss` | root; SIP blocks system/protected binaries | Process + path, system-wide | Yes (kdebug) | Yes | Covered | Requires root; tracing protected binaries needs SIP relaxed via Recovery (`csrutil enable --without dtrace`); destructive actions disallowed under SIP |
| FSEvents | none | **No PID**; directory or per-file paths + flags | ItemRenamed/ItemRemoved flags, no reliable source→dest pairing | Reports named path; must `EvalSymlinks` to watch targets | Indistinguishable | Coalescing + `MustScanSubDirs` full rescan on drops; latency; cannot separate installer churn from background churn |
| DYLD injection (`DYLD_INSERT_LIBRARIES`) | none to set, but dyld strips `DYLD_*` for restricted processes | In-process only; no PID needed | If interposed | In-process | Lost when env is pruned; detached processes escape | Setuid/setgid, `__RESTRICT`, hardened runtime without `allow-dyld-environment-variables`, and SIP binaries all suppress injection silently; shell scripts and static Go/Rust binaries uncovered; library validation blocks unsigned dylibs |
| `sandbox-exec` | none | None — enforcement, not observation | Only denied operations are logged | N/A | N/A | DEPRECATED; no replacement for CLI process sandboxes; `trace` DSL removed; denies do not enumerate allowed writes |
| APFS snapshots | `tmutil`/`mount_apfs` need root + Full Disk Access in practice; C snapshot API needs `com.apple.developer.vfs.snapshot` | None — whole-volume diff | Inferred by comparing snapshots | Snapshot entries | Covered but unattributed | Privileged/entitled; is itself a global before/after diff, the exact heuristic the rewrite is escaping |

Conclusion: **no usable unprivileged, process-attributing macOS tracer exists.** FSEvents is the best unprivileged *change detector* (with per-file events), but it carries no PID and cannot separate installer activity from background churn. The attribution-capable options (EndpointSecurity, DTrace) are gated by entitlements or SIP, which the plan explicitly excludes. The honest macOS backend is therefore the labeled heuristic fallback.

### Linux (reference platform)

| Mechanism | Privileges | Process-tree / attribution | Rename / unlink | Symlinks | Daemonized descendants | Failure modes |
| --- | --- | --- | --- | --- | --- | --- |
| fanotify | `fanotify_init` needs `CAP_SYS_ADMIN`; since Linux 5.13 unprivileged groups are limited to `FAN_CLASS_NOTIF` + a FID flag, inode marks only, and **PID/pidfd reporting is admin-only** | Per-event PID/pidfd (privileged); no PID for unprivileged groups | `FAN_CREATE`/`FAN_DELETE`/`FAN_MOVED_FROM`/`FAN_MOVED_TO`/`FAN_MOVE` | Marks follow or not; events name the entry | Covered (kernel-level, PID-filtered) | No mount marks or PIDs without `CAP_SYS_ADMIN`; no mmap/msync writes; network-FS events missed; queue overflow drops events; needs a native helper |
| eBPF tracepoints | `CAP_BPF` (+`CAP_PERFMON`); unprivileged BPF disabled by default (`kernel.unprivileged_bpf_disabled=1`, Ubuntu 5.13+, irreversible at 1) | PID/TGID, full syscall args | Yes (`unlinkat`, `renameat2`) | Yes | Covered via lineage/cgroup filter | Root/CAP_BPF; kernel/BTF portability; containers/seccomp; mmap content changes unseen; complex loader |
| `ptrace` / `strace -f` | Unprivileged for same-uid dumpable tracees; Yama `ptrace_scope=1` still allows tracer-as-parent | PID, full syscall stream; `-f` follows fork/vfork/clone | Yes (`unlink*`, `rename*`, `symlink*`) | Exact syscall args | Yes — follows double-fork/setsid; not tied to remaining a direct child | Setuid/setgid exec makes the tracee non-dumpable and drops tracing without root; high syscall-stop overhead; `ptrace_scope` 2/3, containers, and seccomp filters block it |
| inotify (fallback building block) | none | **No PID** (explicit limitation) | Racy cross-directory rename pairing via cookie | `IN_DONT_FOLLOW` | Indistinguishable | Non-recursive; queue overflow; change detection only |
| userns + overlayfs (`bwrap`/`fuse-overlayfs`) | none **if** unprivileged user namespaces are enabled | Path-level attribution of all writes in the overlay upper layer; no PID | Yes | Yes | Covered inside the namespace | Overlayfs-on-userns disabled on some distros (RHEL/Fedora historically); changes install environment/ownership; writes outside the namespace invisible; no macOS equivalent |

Conclusion: Linux is the viable attributed-capture platform. `ptrace`/`strace -f` is the only genuinely unprivileged mechanism with process-tree + PID attribution (with a partial-coverage hole at uid transitions); `fanotify` gives the cleanest, lowest-overhead event stream with PIDs and move pairing but needs `CAP_SYS_ADMIN` (standard sudo, no entitlement gate). `userns` + overlayfs is a promising unprivileged alternative worth a spike but is outside the plan's named set. macOS has no equivalent.

### Recommendation

- **macOS:** commit to the labeled heuristic fallback (`capture.backend: "macos-heuristic"`, `capture.completeness: "heuristic"`) built from scoped snapshots plus content hashes. Keep the backend interface so an opt-in entitled/privileged tracer can be added later without a format change.
- **Build order:** Linux first, as the reference backend that validates pure event→record normalization independently of macOS constraints. Within Linux, implement **fanotify** (`FAN_CLASS_NOTIF` + `FAN_REPORT_FID`, invoked through the chosen privilege path) as the primary backend because it yields per-event PIDs and rename/unlink pairing with kernel efficiency; keep `ptrace`/`strace -f` behind the same interface as the zero-privilege, same-uid alternative, and label capture partial when tracing is lost at a uid transition. macOS then gets only the heuristic fallback.

### Sources

- Apple, `com.apple.developer.endpoint-security.client` entitlement (request-only): https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client
- Apple, `es_new_client` (entitlement + TCC + root): <https://developer.apple.com/documentation/endpointsecurity/es_new_client(_:_:)>
- `fs_usage(1)` — "requires root privileges due to the kernel tracing facility": https://keith.github.io/xcode-man-pages/fs_usage.1.html
- `dtrace(1)` / SIP note on destructive actions and kernel access: https://www.manpagez.com/man/1/dtrace/osx-10.12.6.php and https://poweruser.blog/using-dtrace-with-sip-enabled-3826a352e64b
- Apple, File System Events Programming Guide (directory-level granularity, coalescing, must-scan-subdirs): https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/TechnologyOverview/TechnologyOverview.html
- `fsnotify/fsevents` caveats (path granularity, symlink eval, watch limits): https://github.com/fsnotify/fsevents/blob/main/README.md
- Apple DTS on `DYLD_INSERT_LIBRARIES` and protected executables: https://developer.apple.com/forums/thread/731358
- Hardened Runtime / SIP library-injection protections: https://developer.apple.com/documentation/security/hardened-runtime
- `sandbox-exec(1)` DEPRECATED and denials logged to the unified log: https://man.freebsd.org/cgi/man.cgi?query=sandbox-exec&sektion=1&manpath=macOS+10.13.6
- `tmutil(8)` — verbs require root and Full Disk Access: https://keith.github.io/xcode-man-pages/tmutil.8.html
- Apple `vfs.snapshot` entitlement (snapshot read API is request-only): https://github.com/restic/restic/issues/3714
- `fanotify(7)` — privileges, admin-only PID reporting, limitations: https://man7.org/linux/man-pages/man7/fanotify.7.html
- Kernel `fanotify.h` — `FANOTIFY_ADMIN_INIT_FLAGS` includes `FAN_REPORT_PIDFD`/`FAN_REPORT_TID`: https://github.com/torvalds/linux/blob/master/include/uapi/linux/fanotify.h
- Kernel commit "support limited functionality for unprivileged users" (since 5.13): https://github.com/torvalds/linux/commit/7cea2a3c505e87a9d6afc78be4a7f7be636a73a7
- Kernel `unprivileged_bpf_disabled` sysctl: https://www.kernel.org/doc/html/latest/admin-guide/sysctl/kernel.html#unprivileged-bpf-disabled ; eBPF capabilities: https://docs.ebpf.io/linux/concepts/token
- `strace(1)` — `-f` follows fork/vfork/clone, setuid drop without root: https://man7.org/linux/man-pages/man1/strace.1.html
- Yama `ptrace_scope` semantics: https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html
- `inotify(7)` — no process/user attribution, non-recursive, racy rename pairing: https://man7.org/linux/man-pages/man7/inotify.7.html
- `bwrap(1)` — unprivileged namespaces, `--overlay`/`--tmp-overlay`: https://manpages.debian.org/testing/bubblewrap/bwrap.1.en.html

## Decisions log

Each entry resolves or explicitly defers one item from "Open decisions". Status is `decided` or `deferred` (a deferred item carries its chosen default). Date is the decision date.

### D1. macOS capture mechanism

- **Decision:** No unprivileged macOS mechanism provides process-tree-attributing capture. Ship the labeled heuristic fallback as the macOS backend (`capture.backend: "macos-heuristic"`, `capture.completeness: "heuristic"`) and retain the backend interface so a future opt-in entitled/privileged tracer can produce the same record format.
- **Rationale:** EndpointSecurity needs an Apple-granted entitlement plus root; DTrace/`fs_usage` need root and SIP relaxation; FSEvents/kqueue detect changes without PID attribution; DYLD injection is defeated by SIP, hardened runtime, setuid, scripts, and static binaries; `sandbox-exec` is a deprecated enforcement tool; APFS snapshots are a privileged global diff. See "macOS capture feasibility".
- **Status:** decided
- **Date:** 2026-10-09

### D2. Backup default policy

- **Decision:** Before-image blobs are **off by default** and enabled only by explicit opt-in (per install or config), recorded in the record. With backups off, still store before/after content hashes and mark the record non-restorable. With backups on: private `~/.tret/objects/`, atomic writes, content-addressed dedup, configurable size limit, reference-aware GC.
- **Rationale:** prior config files can contain secrets, so silent capture is a privacy hazard; hashes preserve detection/logging value without exposing contents. Over-limit or unreadable files are recorded as mutations but not claimed restorable.
- **Status:** decided
- **Date:** 2026-10-09

### D3. Fallback scope

- **Decision:** Both: curated per-OS default roots **and** user-configurable additions/removals. Defaults cover tool dot-directories, `.config`, `.local`, common shell rc files, `/usr/local`, and selected `~/Library` subdirectories on macOS; `/usr/{bin,local}`, `/opt`, `~/.local/{bin,share,lib,state}`, `~/.config`, XDG dirs, `~/.config/systemd/user`, `~/.local/share/applications`, and package-manager bin dirs on Linux.
- **Rationale:** fixed defaults give predictable, bounded scans; user overrides adapt to unusual installers without rebuilding a sprawling exclusion list. Scope is revisited with test fixtures and real installer examples.
- **Status:** decided
- **Date:** 2026-10-09

### D4. Ownership-conflict resolution

- **Decision:** Model ownership as shared references. Multiple records may claim one path; ownership is never inferred from a matching basename and never silently transferred. Uninstall removes or restores a path only when this record's installed fingerprint still matches **and** no other record claims it, unless the user passes `--force`. Overlapping claims are reported as a conflict requiring user action; an explicit transfer primitive may resolve it. This replaces name-based `removeGuarded()` pruning.
- **Rationale:** "latest record owns the path" and basename pruning are exactly the unsafe heuristics the rewrite removes; explicit shared ownership makes conflicts visible instead of destructive.
- **Status:** decided
- **Date:** 2026-10-09

### D5. `tret trace` scope

- **Decision:** Defer `tret trace` past the first rewrite (phase 8, after install-time capture is trustworthy). **Chosen default until then:** no `trace` command; only the bounded install window is observed, its start/end is reported, and the record reserves per-segment captures so tracing can be added without a format migration. Remove the implicit `--help` first-run dependency now.
- **Rationale:** install-time capture reliability is the plan's priority; shipping a trace surface before capture is trustworthy multiplies blind spots. The reserve-in-record choice avoids a later migration.
- **Status:** deferred (default: not in the first rewrite; implemented in phase 8)
- **Date:** 2026-10-09

### D6. Non-zero installer exit policy

- **Decision:** On a non-zero installer exit, persist a **partial** record (`capture.completeness: "partial"`), do **not** auto-undo, and report the exit code plus how to inspect or remove the changes. Attribution uses the journal gathered before the exit.
- **Rationale:** auto-undo risks deleting user data when attribution is wrong; a labeled partial record keeps retry and uninstall safe and honest. No silent deletion on failure.
- **Status:** decided
- **Date:** 2026-10-09

### D7. Backend implemented first

- **Decision:** Implement the **Linux** backend first as the reference. Linux primary backend: `fanotify` (`FAN_CLASS_NOTIF` + `FAN_REPORT_FID`) invoked through the chosen privilege path, giving per-event PIDs and rename/unlink pairing. The unprivileged same-uid `ptrace`/`strace -f` backend sits behind the same interface as the zero-privilege alternative. macOS ships only the heuristic fallback.
- **Rationale:** Linux offers kernel-level attribution with a stable ABI and no entitlement gate, so it validates pure event→record normalization independently of macOS limits. `fanotify` is efficient and event-rich; `ptrace` is the only genuinely unprivileged full-attribution option and is labelled partial when tracing is lost at a uid transition.
- **Status:** decided
- **Date:** 2026-10-09

### D8. Privileged/sudo policy

- **Decision:** **Support** privileged installs. Run the install as the user by default; when the script escalates, record `privilege: "user" | "root"`, mark capture `partial` when the traced tree is lost at the uid transition, and make uninstall sudo-aware for root-owned entries. Never silently sudo on the user's behalf; state when sudo is required.
- **Rationale:** refusing sudo would block many real Linux installers; putting privilege in the record keeps attribution, ownership, and uninstall behavior explicit rather than implicit per platform.
- **Status:** decided
- **Date:** 2026-10-09

### D9. Artifact format

- **Decision:** Ship `.tar.gz` archives per target, `tret-{darwin,linux}-{arm64,x64}.tar.gz`, with a `checksums.txt`. `scripts/install.sh` and `updatecheck.ts` select the artifact from `uname -s`/`uname -m`, verify the SHA-256 (`shasum -a 256` on macOS, `sha256sum` on Linux), extract, and install the binary; the running artifact's `os`/`arch` is available to `tret update`.
- **Rationale:** archives preserve execute bits and metadata uniformly across platforms and allow a directory layout, while checksums remain the integrity check. Replaces the hardcoded `tret-macos-arm64`.
- **Status:** decided
- **Date:** 2026-10-09

### D10. Case-sensitivity detection

- **Decision:** Never hardcode it. Probe each relevant mount once at install/uninstall by testing a case-variant of a temporary name, cache the result per mount/device, and store a `caseSensitive` flag on the record for use by collision and ownership comparisons. If a probe is impossible, fall back to a per-record flag, and only as a last resort assume case-insensitive on macOS and case-sensitive on Linux.
- **Rationale:** the plan forbids assuming the macOS default; comparisons and shared-path claims must be case-correct per filesystem, and persisting the flag keeps uninstall correct if the mount's behavior later differs from the install-time assumption.
- **Status:** decided
- **Date:** 2026-10-09

## Build execution

Phases follow the Implementation sequence. Each phase lists deliverables, exit criteria, and dependencies.

### Phase 1 — Requirements and spike

- **Deliverables:** inventory of representative installers and fixtures; coverage/privilege/process-tree/rename/symlink/daemonization/case-sensitivity findings per OS; this Decisions log; the "macOS capture feasibility" section.
- **Exit criteria:** every Open Decision resolved or deferred with a chosen default; macOS feasibility recommended; fixture installers selected.
- **Dependencies:** none.

### Phase 2 — Platform abstraction

- **Deliverables:** the `Platform` seam (scope/search roots, shell configs, privilege policy, artifact naming, filesystem case behavior) defined together with the capture-backend interface; existing macOS-specific tables moved behind it.
- **Exit criteria:** core compiles and the test suite passes against both a macOS and a Linux platform table.
- **Dependencies:** Phase 1 (D3 scope, D8 privilege, D10 case).

### Phase 3 — Data model and pure normalization

- **Deliverables:** journal event types; normalization rules (temp-file+rename → destination change, create+delete cancel-out, rename → source removal + destination create/replace, overwrite/delete before-image handling); ownership and conflict semantics; v3 record shape; hash/backup policy; pure events→record conversion with tests.
- **Exit criteria:** unit coverage for create/write, overwrite, delete, rename-overwrite, symlink, chmod, temp-file, nested-directory, and create-then-delete; v3 shape frozen.
- **Dependencies:** Phase 2 interface; D2 backup, D4 conflicts.

### Phase 4 — Capture backend

- **Deliverables:** Linux backend first (`fanotify` primary, `ptrace`/`strace -f` unprivileged alternative) plus the macOS labeled heuristic fallback; completeness metadata (`complete`/`partial`/`heuristic`).
- **Exit criteria:** backends pass conformance tests against shared fixture event streams; unrelated churn is not attributed by a complete backend; partial/daemonized cases are reported incomplete, never complete.
- **Dependencies:** Phase 2 interface, Phase 3 normalization, D1, D7.

### Phase 5 — Install integration

- **Deliverables:** install execution routed through the backend; preserved installer stdout/stderr behavior, script hashing, executable selection, privilege handling, and failure handling; partial records for failed/interrupted installs.
- **Exit criteria:** failed or interrupted installs never create misleading complete records; behavior matches D6 and D8.
- **Dependencies:** Phase 4; D6, D8.

### Phase 6 — Storage and migration

- **Deliverables:** content-addressed blob storage, atomic record/blob writes, restrictive permissions, size limits, reference cleanup, and v2→v3 migration.
- **Exit criteria:** migration tests with representative v2 record files; malformed records rejected without erasing user records; GC removes only unreferenced blobs; legacy records gain no fabricated restore capability.
- **Dependencies:** Phase 3 v3 shape; D2.

### Phase 7 — Safe uninstall

- **Deliverables:** fingerprint verification, restore/remove planning, conflict handling, dry-run output, partial retry records, conservative directory cleanup, and sudo-aware handling for root-owned installs.
- **Exit criteria:** uninstall verifies installed state before changing anything and preserves diverged user data by default; dry-run equals the actual plan; shared-path conflicts behave per D4; behavior matches D8.
- **Dependencies:** Phase 6; D4, D8.

### Phase 8 — Lazy-write workflow

- **Deliverables:** removal of the automatic `--help` dependency; documented bounded install session; deferred `tret trace` design and record segment reservation.
- **Exit criteria:** no silent execution of installed tools; the observation window and process-tree coverage are shown to the user.
- **Dependencies:** Phase 5; D5.

### Phase 9 — Distribution, commands, docs, and rollout

- **Deliverables:** `os`/`arch` artifact matrix built and published by CI; `scripts/install.sh` and the self-update check select the running platform's archive and verify checksums; `install`, `uninstall`, `list`, and `find` updated as required; documentation for capture completeness, privacy/backup defaults, unsupported cases, migration, and recovery; legacy path retained until parity.
- **Exit criteria:** acceptance criteria 1–7 met; README usage and safety claims match shipped behavior; the shared core builds and passes against both platform tables and adding a platform stays confined to a backend module plus a platform table.
- **Dependencies:** all prior phases; D9.
