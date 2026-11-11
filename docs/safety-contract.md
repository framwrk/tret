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
cleanup. Separate weaker-capture consent and per-path cleanup authority remain
open implementation work.

## Classification

On Linux, requesting `O_CREAT` does not establish that a file was created: it may
open an existing file. Only a successful exclusive-create observation can produce
a new file from that open. A missing entry in a pruned baseline is unknown, not
proof of absence. A write without prior-state evidence stays a mutation; a later
unlink retains an uncertain deletion rather than establishing a temporary file.

Consequently, an installer that only uses plain redirections to create commands
under real strace may retain a partial record with no owned executable. An
installed content hash alone cannot upgrade that observation to creation proof.

A rename retains the destination's captured before-state. Without destination
evidence, the destination stays a mutation, never a newly owned file. A backup
of the source is not a backup of an overwritten destination. Unsupported rename
semantics and unobserved state remain limitations of capture.

## Revalidation and shared claims

Cleanup compares the planned content/link state and filesystem identity again
before applying each action. Identity includes device, inode, type, and the
ancestor chain, including existing platform aliases such as macOS `/var`.
Replacing a parent with a symlink or replacing a file with identical bytes
invalidates the plan. An unreadable ancestor makes inspection unverifiable.

These checks detect substitutions before revalidation; path-based filesystem
operations still have a race between the last check and the syscall. They do not
provide an atomic directory-relative removal guarantee or protect against a
malicious concurrent process with the same privileges. Ordinary directory removal
is non-recursive. Tret does not invoke package managers or recursively delete
recognized managed-install roots during cleanup. A marker, launcher, package name,
matching fingerprint, or old `complete` label cannot authorize all descendants or
manager lifecycle hooks. No verified adapter currently supplies that authority.

Uninstall, its dry-run, forced reinstall, and tracked update refuse these scopes
with exit 5 before cleanup or replacement execution. `--yes` and `--force` do not
bypass the refusal. `inspect` marks the plan incomplete and reports the blocked
scope. Shared-claim conflicts remain visible. Launchers, payloads, and records stay
intact for manual reconciliation; `forget` only discards tracking, not the files.
Recognizing a layout from a legacy executable can block unsafe cleanup but never
authorizes a fresh removal scope. This containment does not implement a verified
payload inventory, package lifecycle adapter, or recovery workflow.

`--force` can permit a known content/link mismatch already present in a preview.
It cannot override another record's claim, including shell-config claims, or a
change between planning and applying. Resolve shared claims with `unclaim`.

## Shell edit provenance

Tret does not delete profile lines by matching a tool name, installer marker or
owned path. Those lines may predate the installer even when the final profile hash
matches. The name-based line editor is disabled.

Recorded shell mutations/deletions without a before-image remain unresolved.
Uninstall, its dry-run, forced reinstall, repeated install and tracked update exit
5 before cleanup or replacement execution; profiles, executables and records are
preserved for manual reconciliation. `--yes` and `--force` cannot grant edit
provenance. `inspect` marks the plan incomplete and lists `shell.blocked`, including
missing profiles and configured direct snippet paths. Recognizing a profile path
only authorizes refusal, never a write.

Matching uses normalized recorded spellings and the declared platform table; it
does not resolve symlink aliases. Equivalent target spellings, symlinked homes or
profiles, and undeclared locations such as Linux `/etc/profile` or Darwin
`~/.zshrc.d` can miss this guard and retain the existing detect-only limitations.
Broader identity-aware scope reporting and retained receipts remain open work.
Because backups default to off, an install that edits a declared profile will
usually remain blocked until manual reconciliation and an explicit tracking
discard. Repeating the installer or adding `--force` does not resolve that state.

Before-images remain with the ordinary file planner's whole-file restoration
checks. This containment does not establish attribution from a backup or implement
precise edit reversal, three-way merging, broader per-effect authority or recovery.
`forget` discards tracking without editing a profile or removing the executable.

## Backup privacy

Backups are opt-in and have a per-file limit. Both heuristic backends and Linux
capture exclude the sensitive directory/file names declared in
`src/constants.ts`, including `.ssh`, `.aws`, `.netrc`, and Keychains. Explicit
observation roots do not override those content exclusions. Name-based exclusions
cannot identify every secret. Size limits apply to returned bytes as well as the
pre-read stat; aggregate and streaming resource limits remain separate work.

## Remaining implementation work

The safety plan also requires per-effect cleanup authority, retained receipts,
explicit weaker-capture consent, durable operations, race-resistant filesystem
primitives, bounded recovery storage, verified delegation, precise restoration,
and native acceptance/release gates. Until these are implemented and verified,
heuristic fingerprints and a successful uninstall are not proof that every effect
belonged to the installer or that an installation was fully reversed.
