# Record storage and recovery limits

`list` and `inspect` interpret legacy v2 records in memory. They do not rewrite
`records.json` or persist a migration. Commands may still write their disclosed
private run logs and update-check cache.

The first record mutation preserves the exact legacy bytes in an owner-only file
named `records.json.legacy-v2-<sha256>.json` under `~/.tret/`, then writes v3 records
while holding the records lock. Migration does not invent ownership, fingerprints,
before-images, or restoration capability. If the original cannot be preserved,
the write fails and leaves the active legacy file unchanged. A matching original
from an interrupted attempt is validated and flushed before reuse.
If that retained file has different bytes, mutations fail closed and preserve both
files for manual reconciliation; retrying alone cannot resolve the mismatch.

Original copies retain historical metadata even after an active record is
forgotten. They are recovery evidence, not active ownership claims. Evidence
discard and automated crash reconciliation remain separate implementation work.

## Locked records

Record mutations wait up to five seconds for `records.json.lock`. A lease records
its process id and a unique token. Only that lease is released by its writer;
another writer's replacement lease is preserved. A lock is never reclaimed merely
because it is old. Slow or paused writers can still be alive.

An interrupted or unknown owner keeps writes blocked. Do not remove a lock based
on its timestamp. Establish that no Tret writer is running and preserve the state
before manually reconciling it. There is no automated lock-recovery or interrupted
operation-resume command yet. Reading records does not need the records lock.

## Corrupt records and recovery content

Invalid records fail closed instead of becoming an empty store. The storage-layer
quarantine API runs under the records lock, preserves the corrupt bytes, and refuses
to overwrite an existing recovery file. No CLI command exposes this API yet, and
read commands never quarantine records automatically.

Command garbage collection retains blobs while quarantined record entries exist.
Their full reference graph may be unknown, so an empty active store cannot
authorize deleting that recovery content. This may retain otherwise unused blobs
until evidence is explicitly reconciled/discarded. Legacy v2 originals cannot
reference blobs and do not prevent collection. The reference read and sweep share
the records lease with record mutations and quarantine.

## Filesystem boundaries

Private reads reject symlinks and non-regular files. Private state directories
(`.tret` and `objects`) must be real directories, not symlinks. Atomic writes create
unpredictable temporary files exclusively with no-follow flags, handle short
writes, set permissions through descriptors, and flush file data and the containing
directory. Restore writes preserve the permissions of existing parent directories.
Failed exclusive creates remove their incomplete lock or original file so a later
attempt can retry. Existing names are never removed by a failed exclusive open.

A failure before rename leaves the destination unchanged and removes the write's
temporary file. A directory-flush failure after rename may leave the replacement
visible even though durability was not confirmed. Filesystem/platform guarantees
still limit behavior after power loss; file writes are not a transaction covering
an entire installation.
This also applies to restored user files: filesystems that reject directory
flushes, or parents that cannot be opened for reading, may report a failed restore
after its replacement bytes are visible.

These remain path-based operations. Directory checks do not eliminate ancestor
substitution races or provide tamper-proof storage against the same user. Whole
operation locking, revisions, durable installer checkpoints, active blob pins,
interrupted-apply recovery, and stronger directory-relative operations remain open.
