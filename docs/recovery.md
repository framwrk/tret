# Records, operations and recovery

Read commands normalize v2/v3 evidence in memory without rewriting `records.json`.
Migration invents no ownership, absence, causality or cleanup approval. Version 4
stores an increasing sequence, record revisions and per-effect evidence/decisions.
Older readers reject this wrapper. Before external work, the writer commits the
format barrier and a durable operation intent. Refusal before execution consent or
cleanup preflight does not migrate records.

The first migration retains the exact raw original in an owner-only file named
`records.json.legacy-v2-<sha256>.json` or `records.json.legacy-v3-<sha256>.json`.
A matching retained original is validated/flushed before reuse. A mismatched copy
fails closed without replacing either file. Originals are recovery evidence, not
active claims. V3 originals can reference blobs and keep them alive after active
records are forgotten; v2 originals cannot. Explicit original discard remains a
manual reconciliation step.

## Serialization and revisions

One kernel operation lease spans command reads, capture, target application and
persistence. Contention waits up to five seconds. The stable `operation.lock`
file is never unlinked/replaced. The parent and foreground supervisor retain its
kernel lock until the foreground program exits. Its
PID/token metadata is advisory and timestamps never grant permission to steal it.
Internal update/install/cleanup calls reuse the enclosing lease sequentially.
Initial migration additionally acquires the legacy owner-token records lease.
After the v4 barrier, ordinary transactions rely on the kernel lease and create no
second persistent lock to strand. An interrupted migration still using an older
active format can require manual legacy-lease owner reconciliation, never age-based
deletion. An obsolete migration lease does not authorize a v4 write and is left intact.

Saves and removals compare the revision read earlier. Every record mutation
advances the store sequence, including removals, so delete/recreate cannot revive
a stale claim. A revision conflict requires a fresh read and plan.

## Durable evidence

Private operation manifests under `.tret/operations/` contain prior records,
before-image pins, baseline metadata, the last closed capture journal, normalized
record checkpoints and per-action native cursors/outcomes. Permitted before-images
are pinned and flushed before external execution. A persistence barrier failure
refuses execution and cannot trigger fallback/reexecution.

Live capture is not yet incrementally checkpointed. SIGKILL, disk failure or power
loss may leave only a baseline and an unknown interval. Recovery preserves that
uncertainty. Replacement is currently non-atomic: the previous manifest and its
recovery content remain even if a replacement fails after old cleanup.

## Commands

```sh
tret recover
tret recover <operation-id>
tret recover <operation-id> --resume --yes
tret recover <operation-id> --discard --yes
```

Inspection reads summaries without target changes. `inspect <tool-or-record-id>`
also finds related receipts if no active record remains. Resume requires exclusive
store access and reconciles supported native steps/postconditions or available
partial capture evidence. It never runs external code and never blindly overwrites
a later user edit. Finished action outcomes are not replayed. An interrupted
replacement's prior cleanup may finish, but its replacement installer is not run.

Unfinished manifests and retained native cursors block new mutations. Retained
objects must be reconciled manually; explicit discard relinquishes the receipt's
references without deleting target or staging files. Their locations remain in
the discarded summary. JSON/noninteractive recovery decisions require `--yes`.

## Garbage collection and private storage

Both GC entry points serialize their reference read and sweep with writers. Active
records, operations, receipts and retained v3 originals keep referenced blobs alive.
Unknown/corrupt recovery graphs prevent collection. Completed receipts shed unused
baseline-content pins while preserving their prior/current record references.
`forget` drops active tracking, not historical receipts/originals. Receipt discard
releases its pins; a later GC may collect content no other evidence references.

Private reads reject final symlinks/non-regular nodes, and bounded operation reads
check actual bytes. State directories must be real directories. Atomic private
writes use exclusive no-follow temporary files, handle short writes and flush the
file and directory. Failed exclusive writes clean their own partial file; existing
names survive failed exclusive opens. A post-rename directory-flush failure can
leave replacement bytes visible; inspect current state before retrying.

Manifests have a 16 MiB limit. Broader aggregate storage/capture budgets remain
pending. Same-user state is not tamper-proof, and private persistence still uses
path-based primitives. Native target application, its supported scope and further
limits are described in [authority-and-operations.md](authority-and-operations.md).

A foreground supervisor retains the kernel lease until the program exits, even if
Tret is killed. The program receives that descriptor closed; daemonized descendants
do not hold it indefinitely and remain part of the bounded-capture uncertainty.
The `.tret-stage-<uuid>` namespace is reserved for private application staging and
is excluded from capture alongside `.tret`, including explicit observation roots.
