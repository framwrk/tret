import type { AbsolutePath } from "../../../types";

/**
 * One tracer observation, before the filesystem is inspected for before/after metadata. A tracer
 * (strace, the fanotify helper, or a test double) emits these; `reconstruct.ts` turns them into
 * `JournalEvent`s and `backend.ts` assigns sequence numbers and coverage metadata.
 *
 * Keeping the tracer seam at this level means the syscall-string and fanotify-protocol parsers are
 * pure and can be tested against fixed fixture streams on any host, while the runtime spawn logic
 * stays thin (plan section 8).
 */
export type TracerRecord =
  /** An `open`/`openat` that succeeded. `created` is true when `O_CREAT` was requested. */
  | { op: "open"; at: number; pid?: number; path: AbsolutePath; created: boolean; truncated: boolean; mode?: number }
  /** A `write`/`truncate`-style content change on an already-resolved path. */
  | { op: "write"; at: number; pid?: number; path: AbsolutePath }
  /** A rename/move; `from` is gone and `to` now exists. */
  | { op: "rename"; at: number; pid?: number; from: AbsolutePath; to: AbsolutePath }
  /** An unlink/remove of a non-directory node. */
  | { op: "unlink"; at: number; pid?: number; path: AbsolutePath }
  /** A mode change (chmod/fchmod/fchmodat). */
  | { op: "chmod"; at: number; pid?: number; path: AbsolutePath; mode: number }
  /** A symlink creation; `target` is the link text, never followed. */
  | { op: "symlink"; at: number; pid?: number; path: AbsolutePath; target: AbsolutePath }
  /** A directory creation. */
  | { op: "mkdir"; at: number; pid?: number; path: AbsolutePath; mode?: number }
  /** A directory removal. */
  | { op: "rmdir"; at: number; pid?: number; path: AbsolutePath }
  /**
   * A syscall the tracer saw but cannot express as a journal event (for example `mmap` writes,
   * `sendfile`, `copy_file_range`, `xattr`, `chown`). It is reported so coverage can be lowered
   * rather than silently claiming the install was fully observed.
   */
  | {
      op: "unsupported";
      at: number;
      pid?: number;
      syscall: string;
      path?: AbsolutePath;
      reason: string;
    };

/** The operation discriminator of `TracerRecord`. */
export type TracerOp = TracerRecord["op"];

/** What a tracer produced: records in order plus any syscalls it saw but could not express. */
export type TracerResult = {
  records: TracerRecord[];
  /** Unsupported syscall names, deduplicated, for the coverage report. */
  unsupported: string[];
  /** Parser-level gaps (unparseable lines, unknown fds) that also lower coverage. */
  diagnostics: string[];
};
