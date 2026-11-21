# Capture resource limits

Capture preflight prints the effective limits before external execution. Environment
overrides accept positive decimal safe integers only; invalid values refuse with
exit 2. These settings describe one invocation and do not authorize cleanup or
weaker capture. `--yes` and `--allow-weaker-capture` retain their separate meanings.

| Resource                                           | Default   | Environment override              |
| -------------------------------------------------- | --------- | --------------------------------- |
| Inspected nodes, across scans and effect inventory | 50,000    | `TRET_CAPTURE_MAX_NODES`          |
| Recursive directory depth per root                 | 128       | `TRET_CAPTURE_MAX_DEPTH`          |
| Accounted paths, stamps, audit records and events  | 32 MiB    | `TRET_CAPTURE_MAX_METADATA_BYTES` |
| Actual before-image content read                   | 64 MiB    | `TRET_CAPTURE_MAX_BACKUP_BYTES`   |
| Actual fingerprint content read                    | 4 GiB     | `TRET_CAPTURE_MAX_HASH_BYTES`     |
| Journal/effect events                              | 50,000    | `TRET_CAPTURE_MAX_EVENTS`         |
| Raw audit bytes                                    | 16 MiB    | `TRET_CAPTURE_MAX_AUDIT_BYTES`    |
| Raw audit lines, including malformed lines         | 50,000    | `TRET_CAPTURE_MAX_AUDIT_LINES`    |
| Active work per scan/persistence/close phase       | 30,000 ms | `TRET_CAPTURE_MAX_WORK_MS`        |
| A single stored/read blob                          | 64 MiB    | `TRET_CAPTURE_MAX_BLOB_BYTES`     |
| Blob directory, including atomic staging files     | 1 GiB     | `TRET_CAPTURE_MAX_STORE_BYTES`    |

Counters are shared by baseline, fallback attempts, close and installed effect
inventory. Retrying another backend does not reset them. Overlapping roots share
an inventory within a scan; an explicitly selected deeper root is scanned first.
Node and metadata counters bound retained work, rather than measuring exact process
RSS. Directory enumeration is incremental with at most 32 buffered entries per
open directory. Depth limits bound nested directory handles and stack use.

`find` shares these limits across shallow name discovery and descendant
fingerprinting. Discovery streams 32-entry directory buffers and charges every
visited entry, including nonmatching names and attempted search roots. It does
not first allocate an entire directory listing. Duplicate search roots are scanned
once. Exhaustion refuses with exit 5 before saving a record; malformed limits use
exit 2. Existing tracking bytes and targets stay unchanged. Unreadable directories
and unavailable fingerprints remain visible losses in the find segment's resources
and partial reason; absent search directories are expected, not scan losses.
The segment lists the executable and actual search roots. Name matches and a
bounded inventory are still unapproved observations, not attribution or permission
to remove files. The work deadline is shared by discovery and inventory and cannot
interrupt a stalled filesystem call.

Installer runtime and time waiting for weaker-capture confirmation are excluded
from active work deadlines. Checks occur between bounded reads and filesystem
calls; they cannot interrupt a stalled kernel call. A pre-execution budget failure
refuses external execution (exit 5). Exhaustion after execution retains an unknown
receipt/segment and exits 1; the installer or tool is never retried. Missing
fingerprints or before-images can instead be omitted within the remaining budget:
the successful installer result then carries the loss in its capture report and
does not acquire cleanup authority for those effects. The report retains up to
32 loss messages plus an explicit truncation notice.

Normalization has a separate bounded report: at most 32 notes and 64 KiB of
serialized report data per segment, including an explicit `omitted` count. Each
note has a message of at most 1,024 UTF-8 bytes and at most two exact absolute paths
of 4,096 bytes each. Count, byte and entry bounds apply during collection. A note
that exceeds them is omitted and counted; paths are never truncated into invented
names. These reporting limits do not suppress effects or change their authority.
The same report is retained in records and recovery evidence and shown by inspect.

Regular-file fingerprints use 64 KiB streaming reads independently of backup
size. Before-images use the same read chunks into an allocation bounded by both
the per-file limit and remaining aggregate backup bytes. Final symlinks, special
nodes, files that grow/shrink, and identity/mode/timestamp changes during a read
are refused. An EOF probe rejects pseudo-files whose stat size understates their
content; a completely exhausted byte budget cannot verify EOF. These checks do
not freeze another writer or establish process attribution. Heuristic snapshots
still miss same-stamp/transient changes. An unreadable scan is unknown, never
proof of prior absence or deletion. Unknown subtrees affect only their own paths;
readable siblings still retain known presence and absence. Executable naming uses
the bounded effect inventory, including observed mutations, without granting
removal authority or discovering additional descendants.

The default Linux tracer writes to a private audit file. The trusted launcher waits
under strace while Tret confirms its kernel `TracerPid` and applies a soft file-size
limit to the tracer alone. The launcher has already inherited the caller's original
limits. The private scratch file can exceed a very small configured ceiling while
strace starts the launcher. Tret refuses execution and removes the scratch file
if startup reaches that ceiling. An inherited stricter limit may stop the tracer
earlier. Tret checks attachment
again after durable pre-execution persistence. A killed or full tracer yields
partial coverage. Raw output is read within the byte ceiling and removed at close.
Diagnostics are bounded. Development-only fanotify injection also bounds incoming
bytes, lines and retained metadata.

Blob writes hold the operation lease, count existing regular objects and staging
bytes, and refuse new content when full. Deduplication at the ceiling still works.
Retained evidence is never evicted to make room; unknown object types refuse the
quota calculation. Quota enumeration uses bounded buffers and an active time
limit; capture node/metadata caps do not limit the number of retained blobs.
Legacy oversized blobs remain intact but cannot be read for
restore under a smaller configured limit. Other private reads default to 64 MiB;
operation manifests retain their separate 16 MiB ceiling, with verified chunks
supporting logical operations up to 64 MiB. Unreadable, changing or
oversized private evidence fails closed and is preserved.

These are capture and blob limits. [Recovery retention](recovery-retention.md)
separately bounds operation/original evidence and exposes explicit discard/purge.
Strace samples changed live prefixes at one-second intervals, at most 32 times.
Prefix parsing charges each audit byte/line once; metadata reconstruction also
uses the shared node/event/metadata counters. Prefixes avoid content hashes;
final reconstruction still runs on the closed trace. Snapshot backends retain
only their baseline until close. Existing receipts pin
their referenced blobs. No limit makes same-user private state tamper-proof or
turns an unknown interval into an empty installation.
