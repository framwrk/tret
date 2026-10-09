import type { AbsolutePath, CaptureCompleteness } from "../../types";
import type { BlobId } from "../storage";

/** Metadata for a regular file at the time an event was observed. */
export type FileMetadata = {
  kind: "file";
  /** sha256 of the file's content, when the backend could read it. */
  hash?: string;
  size?: number;
  mode?: number;
  mtimeMs?: number;
};

/** Metadata for a directory. */
export type DirectoryMetadata = {
  kind: "directory";
  mode?: number;
};

/** Metadata for a symlink; the target is recorded, never followed. */
export type SymlinkMetadata = {
  kind: "symlink";
  target: AbsolutePath;
  mode?: number;
};

/** The node metadata an event carries about a path. */
export type NodeMetadata = FileMetadata | DirectoryMetadata | SymlinkMetadata;

/** Fields every journal event carries: order, time, and the PID that produced it when known. */
export type JournalEventBase = {
  /** Monotonic position in the journal, assigned as events are observed. */
  seq: number;
  /** Wall-clock time in milliseconds since the Unix epoch. */
  at: number;
  /** Process id that produced the event, when the backend attributes one. */
  pid?: number;
};

/** A node was created. `after` describes the new node; nothing existed before. */
export type CreateEvent = JournalEventBase & {
  type: "create";
  path: AbsolutePath;
  after: NodeMetadata;
};

/** A file's content was written. `before` is present when the prior content was known. */
export type WriteEvent = JournalEventBase & {
  type: "write";
  path: AbsolutePath;
  before?: FileMetadata;
  after: FileMetadata;
};

/** A node moved. Normalization treats this as a source removal plus a destination creation. */
export type RenameEvent = JournalEventBase & {
  type: "rename";
  from: AbsolutePath;
  to: AbsolutePath;
  before?: NodeMetadata;
  after?: NodeMetadata;
};

/** A node was removed; `before` is its last known state. */
export type UnlinkEvent = JournalEventBase & {
  type: "unlink";
  path: AbsolutePath;
  before: NodeMetadata;
};

/** A node's mode changed. */
export type ChmodEvent = JournalEventBase & {
  type: "chmod";
  path: AbsolutePath;
  before?: { mode?: number };
  after: { mode: number };
};

/** A symlink was created at `path` pointing to `target`. */
export type SymlinkEvent = JournalEventBase & {
  type: "symlink";
  path: AbsolutePath;
  target: AbsolutePath;
  after: SymlinkMetadata;
};

/** A directory was created. */
export type MkdirEvent = JournalEventBase & {
  type: "mkdir";
  path: AbsolutePath;
  after: DirectoryMetadata;
};

/** A directory was removed; `before` is its last known state. */
export type RmdirEvent = JournalEventBase & {
  type: "rmdir";
  path: AbsolutePath;
  before: DirectoryMetadata;
};

/** Every filesystem operation a capture backend can report. */
export type JournalEvent =
  CreateEvent | WriteEvent | RenameEvent | UnlinkEvent | ChmodEvent | SymlinkEvent | MkdirEvent | RmdirEvent;

/** The discriminant of `JournalEvent`. */
export type JournalEventType = JournalEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the journal assigns `seq` and `at`; the fake backend and tests use this shape. */
export type JournalEventInput = DistributiveOmit<JournalEvent, "seq" | "at">;

/** The ordered events and coverage metadata one capture window produced. */
export type Journal = {
  backend: string;
  completeness: CaptureCompleteness;
  /** Set when the backend knows attribution is incomplete (daemonized descendants, uid transitions). */
  partialReason?: string;
  events: JournalEvent[];
  /**
   * Pre-install file contents captured for restoration, keyed by their sha256 content address (D2).
   * Only populated when backups are enabled and the file fit the size limit at window start; a
   * mutation or deletion is claimed restorable only when its before hash is present here, so a
   * record never advertises a before-image storage cannot return.
   */
  beforeImages?: Map<BlobId, Uint8Array>;
};
