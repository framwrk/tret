# Capture and removal safety

Tret records bounded filesystem observations. It does not sandbox an installer,
prevent malicious activity, or establish machine-wide reversibility. Installers
run with the caller's privileges; filesystem capture does not cover external
services, credentials, running services, or every privileged effect.

## Execution consent and command validation

An installer or tracked-tool update requires `--yes` when stdin is not a terminal
or JSON output is selected. Missing noninteractive consent exits 5 before fetching
the script or removing the previous install. Interactive installs show the script identity and preview
before asking for consent. Bare `tret update` is an explicit self-update request;
a malformed flag or extra selector must never select that path.

Ordinary URL/selector invocations reject unknown commands/options, duplicate
single-value options, and extra selectors with exit 2 before dispatch. Options can
appear before or after a selector.
Only install accepts `--` followed by arbitrary script arguments; those arguments
cannot supply Tret's execution consent or select its JSON mode. Pasted curl/wget
commands remain inputs from which Tret extracts a URL, not commands it executes.
When the first non-value argument is `curl` or `wget`, downloader options and pipe
text stay opaque; known Tret options still apply. Put Tret options before the paste
to keep the boundary clear. Pasted `sudo` text does not elevate Tret or execute a
privileged shell.
JSON help and version output each contain one document; neither checks for updates.

Execution consent grants permission to run the selected script. It does not prove
that subsequently observed paths belong to the installer or approve broader
cleanup. Per-path cleanup requires a separate explicit approval.

Heuristic/partial capture, disabled capture and pre-execution fallback require
fresh weaker-capture consent. Noninteractive/JSON runs must pass
`--allow-weaker-capture`; interactive runs can answer a separate confirmation.
`--yes` cannot answer that question, and a recorded capture setting cannot replay
the decision. This includes macOS's default heuristic backend and `--no-capture`.
The flag applies to install, trace and tracked update, not bare self-update.
Preflight reports backend, expanded roots, narrowed fallback exclusions, backups
and known limits. Linux checks known prerequisites before baseline scanning or
replacement cleanup; an unexpected attach failure also needs explicit permission
before fallback. No capture failure reruns external code.
Replacement remains non-atomic: an unexpected attach failure after approved old
cleanup can leave that cleanup completed while replacement execution is refused.
This returns exit 1 with a durable partial receipt, not an unchanged-target exit 5.
The preview discloses this before cleanup. Known unavailable prerequisites refuse
with exit 5 before touching the prior install.

## Classification

The Linux CLI attempts strace, including when already root. It does not discover
or select a fanotify helper from the executable directory, HOME or `TRET_FANOTIFY`.
The labeled heuristic fallback requires the separate consent above. This does
not fix strace readiness or establish assured machine-wide capture.

Fanotify is available only to development code that explicitly injects
`attachFanotify` into `LinuxCaptureBackend` with a chosen helper path. Its journal
always reports partial coverage. Its event fidelity is unverified, and the partial
label grants no cleanup authority; its candidates require the same explicit approvals.
The packaged helper remains for experiments. Every record now requires per-effect
cleanup approval; child-launch tracing and real-kernel fidelity tests remain open.

On Linux, requesting `O_CREAT` does not establish that a file was created: it may
open an existing file. Only a successful exclusive-create observation can produce
a new file from that open. A missing entry in a pruned baseline is unknown, not
proof of absence. A write without prior-state evidence stays a mutation; a later
unlink retains an uncertain deletion rather than establishing a temporary file.

An installer using plain redirections under real strace can retain its command
as an observed mutation. That executable can supply a display name without
granting removal authority. An installed content hash alone cannot upgrade the
observation to creation proof.

A rename retains the destination's captured before-state. Without destination
evidence, the destination stays a mutation, never a newly owned file. A successful
`RENAME_NOREPLACE` supplies destination absence at that operation, without replacing
an earlier window-start fact. A backup of the source is not a backup of an
overwritten destination. `RENAME_EXCHANGE` retains both names and their separate
window-start facts; it does not imply that the source disappeared.

Whiteout/unknown flags, directory lineage, a surviving ordinary source (including
a hard-link no-op), and renames crossing observation/exclusion boundaries remain
uncertain. Only safely included endpoints become effects; outside, excluded and
private endpoints are not inspected for content or made cleanup candidates.
Known descendants of an uncertain directory remain detect-only observations,
without inventing an inventory or creation proof. Final sampling can prove absence
at close, not the history of an unobserved interval. These losses reduce coverage
and are retained in bounded normalization explanations. Symlink metadata without
a captured prior target stays unknown. Full directory subtree mapping and historical
alias reconstruction remain open.

Linux reconstruction resolves existing parent components through libc and checks
that the kernel names the same object, before inspecting the final component.
Symlinks are followed before `..`; the final symlink remains its own object.
Resolved suffixes are recorded under the matching observe-root spelling, so stable
platform aliases retain their baseline and before-images. An unresolved parent,
dangling link, loop, or traversal through a missing/non-directory component reduces
coverage rather than producing an effect at a guessed lexical path. Ordinary
non-traversing missing tails can retain known baseline deletions. Resolution uses
the namespace available during sampling, not a historical reconstruction of alias
changes during the installer; those changes remain a capture limitation.

Normalization explanations (renames, temporary-file cancellation, unsupported
sequences and coverage) are retained in each segment's `normalization` report and
the operation's closed capture. `inspect` displays them; JSON includes their codes,
messages, exact paths and omitted count. Interrupted recovery recomputes notes
from the durable journal without executing code. Notes describe observations;
they neither grant cleanup authority nor mean every effect can be reversed.
Interrupted traces retain the original install metadata, append an unknown-ended
trace segment, and apply the same shared-claim checks as a normal trace.
Existing observation origins are preserved, new observations are labeled as
trace-derived, and recovered candidates require fresh cleanup approval.

Each trace segment also retains a bounded `observations` report, including changes
to paths already tracked by the install and paths claimed by another record.
It records window-before/window-after fingerprints when available, link text,
prior modes and whether the effect became a new candidate or was skipped.
These window facts do not replace the install's original fingerprints,
before-images or cleanup decisions. Runtime documents remain observations;
running `trace --yes` grants no cleanup approval.

The report retains at most 32 entries and 64 KiB, with exact paths/link text up to
4096 UTF-8 bytes each. Invalid or over-limit entries are counted as omitted,
never shortened into a different name. `inspect`, `recover` and trace JSON expose
the report and omitted count; human output labels fingerprints as window facts.
The operation retains its bounded raw journal until explicit evidence disposal,
including observations skipped by claim merging or omitted from this report.
Interrupted recovery recomputes the report against the trace's prior record,
preserves shared claims and never reruns the tool. Older records may lack the
optional report; it carries no authority or additional blob pins.

## Revalidation and shared claims

Cleanup compares the planned content/link state and filesystem identity again
before applying each action. Identity includes device, inode, type, and the
ancestor chain, including existing platform aliases such as macOS `/var`.
Replacing a parent with a symlink or replacing a file with identical bytes
invalidates the plan. An unreadable ancestor makes inspection unverifiable.

Approved target application pins a parent descriptor, captures the candidate in
private staging with no-replace rename, verifies the captured object, and only then
removes/restores it. A substituted object is rolled back or retained for recovery;
restoration cannot overwrite a concurrently reoccupied name. This protects object
identity and namespace boundaries, not writes through already-open descriptors or
hostile same-user tampering. Private-state persistence still has path-based limits.
Ordinary directory removal
is non-recursive. Tret does not invoke package managers or recursively delete
recognized managed-install roots during cleanup. A marker, launcher, package name,
matching fingerprint, or old `complete` label cannot authorize all descendants or
manager lifecycle hooks. No verified adapter currently supplies that authority.

Full recorded-scope uninstall, its dry-run, forced reinstall and tracked update refuse these scopes
with exit 5 before cleanup or replacement execution. `--yes` and `--force` do not
bypass the refusal. `inspect` marks the plan incomplete and reports the blocked
scope. Shared-claim conflicts remain visible. Launchers, payloads, and records stay
intact for manual reconciliation; `forget` only discards tracking, not the files.
Recognizing a layout from a legacy executable can block unsafe cleanup but never
authorizes a fresh removal scope. This containment does not implement a verified
payload inventory, package lifecycle adapter, or automatic delegated recovery.

`--force` can permit a known content/link mismatch already present in a preview.
It cannot override another record's claim, including shell-config claims, or a
change between planning and applying. Resolve shared claims with `unclaim`.

## Shell edit provenance

Tret does not delete profile lines by matching a tool name, installer marker or
owned path. Those lines may predate the installer even when the final profile hash
matches. The name-based line editor is disabled.

Recorded shell mutations/deletions without a before-image remain unresolved.
Full recorded-scope uninstall, its dry-run, forced reinstall, repeated install and tracked update exit
5 before cleanup or replacement execution; profiles, executables and records are
preserved for manual reconciliation. `--yes` and `--force` cannot grant edit
provenance. `inspect` marks the plan incomplete and lists `shell.blocked`, including
missing profiles and configured direct snippet paths. Recognizing a profile path
only authorizes refusal, never a write.

Matching uses normalized recorded spellings and the declared platform table; it
does not resolve symlink aliases. Equivalent target spellings, symlinked homes or
profiles, and undeclared locations such as Linux `/etc/profile` or Darwin
`~/.zshrc.d` can miss this shell-specific guard. They still require explicit
per-effect cleanup approval. Broader identity-aware shell scope reporting remains
open work; operation receipts retain unresolved recorded effects.
Because backups default to off, an install that edits a declared profile will
usually remain blocked until manual reconciliation and an explicit tracking
discard. Repeating the installer or adding `--force` does not resolve that state.

Before-images remain with the ordinary file planner's whole-file restoration
checks and require explicit restoration approval. A backup does not establish
attribution. Precise edit reversal and three-way merging remain pending; the
per-effect approval and recovery boundaries are described in
[authority-and-operations.md](authority-and-operations.md).
`forget` discards tracking without editing a profile or removing the executable.

## Backup privacy

Backups are opt-in and have a per-file limit. Both heuristic backends and Linux
capture exclude the sensitive directory/file names declared in
`src/constants.ts`, including `.ssh`, `.aws`, `.netrc`, and Keychains. Explicit
observation roots do not override those content exclusions. Name-based exclusions
cannot identify every secret. Reads, streaming fingerprints, aggregate capture
work and blob storage now have [numeric resource limits](capture-budgets.md).
Over-budget, changing and unreadable content stays unavailable, with visible loss.

## Explicit authority and receipts

V4 normalization gives legacy records no approvals. `approve` binds one remove or
regular-file restore to the current object, parent chain and content/link state;
this is user authorization, not process attribution. Default cleanup preflights all
recorded effects. `--approved-only` explicitly selects an approved subset and keeps
other effects/scopes visible and tracked after the executable is gone. Protected
roots, hard-link aliases, unsupported nodes, missing parents, missing/corrupt blobs
and stale approvals remain blocked. Directory approval is non-recursive.

Whole-command kernel leases, record revisions, durable operations and native action
cursors retain available evidence across interruption. Resume never reruns an
installer or blindly repeats a completed restore. See [authority and operations](authority-and-operations.md)
and [recovery](recovery.md) for commands, supported scope and current limits.

## Remaining implementation work

Strace keeps bounded partial live prefixes; snapshot-only capture keeps its baseline
until close. Prefixes grant no cleanup approval and never prove a complete interval.
The safety plan still requires the broader interruption/lifecycle matrix, complete rename semantics,
verified delegation, richer precise restoration,
and native acceptance/release gates. Until these are implemented and verified,
heuristic fingerprints and a successful uninstall are not proof that every effect
belonged to the installer or that an installation was fully reversed.
