# Cleanup authority and durable operations

Version 4 implements the evidence and operation boundaries below. Work explicitly
marked pending is not implemented. See [safety-contract.md](safety-contract.md) for
capture limits and [recovery.md](recovery.md) for the recovery commands.

## Evidence and authorization

Capture observations describe candidate effects. Process attribution, coverage,
before-image availability, installer exit status and cleanup outcome are separate
facts. Neither an installed hash, a backup, an exclusive-create syscall without
object identity, nor a historical `complete` label independently authorizes
cleanup. This applies to every backend and to runtime traces.

Version 4 records carry a revision and per-effect decisions. Migration from v2 or
v3 preserves observations and before-images but supplies no cleanup approvals.
Unknown optional fields in legacy files cannot inject approvals. Older readers
must reject the version 4 wrapper without changing its bytes. The first mutation
retains the exact original, including any blob references in a v3 original.

`approve --revoke` withdraws a decision without target changes.
Path approval is explicit, limited to an enumerated action on one object,
and bound to the effect, current identity, parent chain and content/link state.
It is labeled user authorization, never process proof. Approving a directory
does not approve descendants. Execution consent, `--force`, a tool name and a
package marker cannot supply this decision. Shared/protected roots and unsupported
nodes remain blocked. Changed evidence invalidates an earlier decision.

## Operation protocol

Conflicting mutations use one kernel-held operation lease per store, with a
five-second bounded wait. Internal calls reuse the enclosing operation; unrelated
concurrent calls must contend. The stable private lease file is never unlinked or
replaced. The last holder closing releases the kernel lease; a foreground
supervisor retains it after the Tret parent dies. Durable intent survives both.
Filesystem support for locking is required; failures refuse work.

Lock order during initial migration is operation lease, then legacy records lease.
V4 transactions use the enclosing kernel lease without another persistent lock.
Read-only previews require neither a long operation lease nor a migration write.
Record writes compare the expected revision and advance a store-wide sequence;
deleting and recreating an id cannot make an old revision current again.

An operation intent is flushed before external execution or target modification.
It retains prior records, active blob pins, checkpoints and the last known stage.
Stages distinguish preparation, execution, captured evidence, application and a
completed/partial outcome. An unfinished intent or retained native cursor blocks new store mutations
until explicit recovery/discard. Recovery never reruns an installer automatically.

The baseline metadata and permitted before-images are persisted before execution.
The closed journal and normalized record are checkpointed afterward. Incremental
checkpoints while external code is running remain pending; a killed process may
retain only its baseline and an explicitly unknown interval. A crash can leave an unknown interval
after the last checkpoint. Disk failure, power loss and unobserved effects do not
become evidence of absence. A failed replacement retains the previous manifest
and partial new evidence even when replacement cannot be atomic.

Receipts retain unresolved effects and recovery references after an executable is
gone. Garbage collection accounts for active records, retained originals,
operations and receipts. Unknown recovery graphs prevent collection. Explicit
evidence discard relinquishes these references without modifying target files.

## Application and outcomes

Inspect, dry-run and apply use the same read-only preflight, including authority,
blob integrity, shell/delegated scopes, shared claims and privilege requirements.
Apply revalidates prerequisites and uses supported directory-relative, no-follow
operations bound to the approved object. An unsupported native capability refuses
cleanup; repeated path checks do not claim atomicity.

An object captured for removal is verified before deletion. A substituted or new
object is preserved. Restores never overwrite a concurrently reoccupied name;
incomplete rollback keeps recovery evidence. Empty directories are removed
non-recursively. Special nodes and unsupported metadata remain unresolved.

Exit 5 means refusal before target application. A change during apply, failed
postcondition or unresolved requested effect yields exit 1 and a durable partial
receipt. Exit 0 means the explicitly requested, enumerated scope was verified
complete. It does not mean machine-wide or historical reversal. A deliberately
narrower approved scope names retained data and unknown coverage explicitly.

## Supported scope and remaining limits

`approve <tool> <path> --remove|--restore` approves one exact current object.
`uninstall --approved-only` selects the approved effects and retains other claims
and named unresolved scopes. Full recorded-scope preflight refuses before apply
when any required authority, restoration or shared-scope check fails.

Native application supports regular files, symlinks and empty directories. Restore
supports regular-file bytes and ordinary permission bits under an existing parent.
Missing parents, hard-link aliases, special nodes and special permission bits are
refused. Native metadata handles use Linux O_PATH or Darwin O_EVTONLY/O_SYMLINK;
content is read only after regular-file inspection and descriptor revalidation.
Private staging and pinned parents protect names/object identity; they do not
freeze writes through existing descriptors or sandbox hostile same-user processes.
Content verification streams 64 KiB chunks, with a 4 GiB/30-second per-file budget.
Operation manifests are capped at 16 MiB and are read with an actual byte bound.

`recover` summarizes receipts, baseline size, capture loss and unknown intervals.
`recover <id> --resume --yes` reconciles supported filesystem cursors or publishes
available partial capture evidence. It never reexecutes an installer or traced tool.
A retained cursor requires manual reconciliation and explicit evidence discard;
discard never deletes target/staging files and keeps their locations. `inspect`
finds related receipts when no active record remains.

Broader aggregate capture/recovery budgets, in-flight capture checkpoints, separate
weaker-capture consent, richer metadata and precise shell-edit reversal remain
pending. Legacy-original discard is currently manual. The version barrier prevents
new older-reader commands from using the store; it cannot retroactively coordinate
an already-running old installer. Mixed-version concurrent operations are unsupported.

A foreground supervisor retains the kernel lease until the program exits, even if
Tret is killed. The program receives that descriptor closed; daemonized descendants
do not hold it indefinitely and remain part of the bounded-capture uncertainty.
The `.tret-stage-<uuid>` namespace is reserved for private application staging and
is excluded from capture alongside `.tret`, including explicit observation roots.
