# Recovery retention and explicit evidence disposal

Retained operation manifests and chunks, original record files, corrupt quarantines and their
interrupted atomic staging share one inventory. Nothing expires or is evicted to
make room. Blob storage has its separate [capture-resource quota](capture-budgets.md).

| Limit                                            | Default   | Positive decimal integer override |
| ------------------------------------------------ | --------- | --------------------------------- |
| Retained physical bytes including atomic staging | 128 MiB   | `TRET_RECOVERY_MAX_BYTES`         |
| Combined current logical operation payloads      | 128 MiB   | `TRET_RECOVERY_MAX_BYTES`         |
| Retained recovery entries                        | 1,024     | `TRET_RECOVERY_MAX_ENTRIES`       |
| Active directory enumeration                     | 30,000 ms | `TRET_RECOVERY_MAX_WORK_MS`       |

Malformed overrides refuse with exit 2. Enumeration uses 32-entry directory
buffers and never follows non-regular recovery entries. Listing stops before
loading an over-limit graph. Individual operation manifests remain capped at
16 MiB, reconstructed operation payloads at 64 MiB, and originals/private reads at 64 MiB. These are retained-byte and work
limits, not an exact process-RSS guarantee or cancellation of stalled kernel calls.

The byte setting applies independently to physical evidence and current logical
operation payloads. Reused chunks can make physical storage much smaller than the
decoded data. Listing charges each immutable manifest snapshot's logical length
before reading its chunks, with cooperative time checks between bounded reads.
Legacy v1 manifests contribute their original byte length without migration.

New intents require 32 MiB of checkpoint headroom (half the total under a smaller
explicit override). Every regular write also checks its actual staging peak.
Intent headroom also applies to the combined logical payloads; replacement checks
exclude the old payload of that same ID. A logical refusal happens before new
chunks or a replacement manifest are written. Physical retention still includes
all historical generations. Accumulated history or lowering the byte limit can
make aggregate listing refuse. Byte-limit errors name an ID, and exact-ID
inspection/discard/purge remain available
within their individual limits, without decoding unrelated receipts. Discard
stays an explicit exception so evidence cannot become impossible to address.
Atomic staging can temporarily add one directory entry. Migration originals and
explicit corruption quarantine participate in the same quota. Interrupted staging
or corrupt/unknown graphs prevent blob collection. Blob-directory GC enumeration
also streams entries with an active-work deadline.

A known quota refusal before execution exits 5 without running external code.
Failure after work may have started exits 1, retaining the last durable cursor
and its unknown interval. It never retries an installer. Strace live prefixes
share these quotas and stop at 32 publications; snapshot-only backends retain
their baseline until close. See [durable evidence](recovery.md#durable-evidence).

## Chunked operation evidence

New manifests use physical version 2; older readers refuse them before mutations.
Version 1 receipts remain readable without migration. Logical payloads up to
256 KiB stay inline. Larger payloads use immutable SHA-256-addressed chunks of at
most 1 MiB, named `<operation-id>.<sha256>.part` beside the manifest. Readers
verify every referenced chunk and its length before reconstructing an operation;
missing, changed or unsupported chunks fail closed. The manifest is published
atomically only after its chunks are flushed. A small prepared intent precedes
a large initial snapshot, so interrupted writes retain an addressable operation.

Unchanged chunks are reused. Encoding generations and their conservative blob
pins remain until explicit receipt discard, including after completion. At most
1,024 distinct chunks are retained per operation, also subject to the aggregate
byte/entry limits. A failed publication preserves the last readable manifest and
any available new chunks. Unpublished chunks are listed by path and prevent blob
GC; inspect or explicitly discard their owning operation ID. An orphan whose
manifest is missing requires manual reconciliation. Chunking adds no capture
coverage and does not turn an unknown interval into proof of absence.

Discard first publishes the summary, then verifies and unlinks only that
operation's hashed chunk files through a pinned directory. Failed deletion of
verified chunks leaves the discarded ID retriable. Partial, changed or unsupported
chunks remain for manual reconciliation and continue to be listed by path after
discard; other verified own chunks are still cleaned. Discard relinquishes blob
pins even if such remnants remain. Purge requires resolving those remnants before
deleting the summary. Neither action removes target files or another operation's chunks.

## Select evidence explicitly

```sh
tret recover
tret recover <operation-id>
tret recover <operation-id> --discard --yes
tret recover <discarded-operation-id> --purge --yes
tret recover original-v2:<sha256>
tret recover original-v3:<sha256>
tret recover original-v3:<sha256> --discard --yes
```

Listing includes original selectors and their sizes. Exact inspection verifies
the original's streamed content address and bounded record format. Original
discard is a separate, explicit decision: it records a bounded disposition,
quarantines through a pinned directory, revalidates the captured object, then
removes only the selected historical evidence. Active records, installed targets
and other originals are unchanged. Other record/receipt references still pin
their blobs. Mismatched, invalid, hard-linked or unsupported originals remain for
manual reconciliation. A detected substitution is retained instead of deleted.

If interrupted after quarantine, the same original selector locates that exact
known staging name; repeating `--discard --yes` verifies it before finishing.
Ambiguous original/staging copies and unrelated corrupt entries require manual
reconciliation. A disposition receipt records both original and staging locations;
it describes the decision, not proof that an interrupted deletion finished.

Receipt discard relinquishes its references and leaves a compact summary with
retained target-staging locations. Purge is a separate action that accepts only
an already-discarded receipt. It deletes that receipt's metadata and frees its
entry slot; installed targets and staging payloads are never purged. JSON output
includes retained locations. Inspection is read-only; JSON/noninteractive discard
and purge require `--yes`.

Purge verifies and unlinks discarded metadata in its pinned operations directory;
it does not move it into a corrupt quarantine. If unlink fails, the same receipt id
remains available for retry. Listing names unaddressable corrupt/staging evidence
by path for manual reconciliation. Receipt-only `inspect` reports retention
refusals as structured exit 5, or malformed-limit errors as exit 2. A quota failure
after recovery target actions may have started exits 1 and preserves the last
durable cursor; it is not reported as an untouched refusal.

Exact-id inspection/discard/purge remain available when a lowered aggregate limit
prevents full listing. Explicit discard alone may atomically stage a replacement
up to the existing 16 MiB manifest ceiling even over an existing/lowered quota,
so large valid receipts keep all retained locations while relinquishing evidence.
New original-discard decisions have a separate 64 KiB tombstone ceiling. Each
explicitly requested interrupted-discard attempt can retain a bounded decision
receipt; it is counted by inventory and can be explicitly purged after inspection.
Neither action deletes an old manifest before its replacement is durable.
Purging a discarded receipt needs no new
tombstone. Existing over-limit evidence is otherwise preserved. No byte quota
makes same-user private state tamper-proof or freezes another writer.
