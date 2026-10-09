// Types shared across Tret's commands and library code.

// Units

/** Absolute path to a file or folder on disk. */
export type AbsolutePath = string;

/** Last-modified time in milliseconds since the Unix epoch. */
export type MtimeMs = number;

// Snapshots

/** Everything recorded about one tracked entry; the size and inode catch a re-pointed symlink that mtime misses. */
export type FileStamp = {
  mtimeMs: MtimeMs;
  size: number;
  inode: number;
  isDir: boolean;
};

/** Every file and folder Tret tracks, mapped to its stamp. */
export type Snapshot = Map<AbsolutePath, FileStamp>;

// Diff

/** Everything between two snapshots: what an install added, edited, or deleted. */
export type Diff = {
  added: AbsolutePath[];
  edited: AbsolutePath[];
  deleted: AbsolutePath[];
};

// Records

/** One recorded install: the tool, its URL, the executable it put on disk, the script's hash, and the changes its script made. Deletes stay out: uninstall logs edits and never reverses anything but additions. */
export type ToolRecord = {
  name: string;
  /** Whether the tool came through `tret install` or was adopted by `tret find`. */
  source: "install" | "find";
  url: string;
  installedAt: string;
  executable: AbsolutePath;
  scriptSha256: string;
  added: AbsolutePath[];
  edited: AbsolutePath[];
};

/** The records file format, versioned so older builds can be detected. */
export type RecordFile = {
  version: number;
  records: ToolRecord[];
};

// Rewrite: capture and effect model

/**
 * How much of an install's filesystem activity a capture backend could attribute.
 * `complete` proves the process tree was observed end to end; `partial` observed it but lost
 * coverage (daemonized descendants, a uid transition); `heuristic` infers changes without PID
 * attribution. Records carry this so a heuristic macOS record and a complete Linux one stay
 * distinguishable in `tret list` and uninstall output.
 */
export type CaptureCompleteness = "complete" | "partial" | "heuristic";

/** Privilege an install ran under; recorded explicitly instead of implied per platform (D8). */
export type Privilege = "user" | "root";

/**
 * One bounded observation window that fed a record. A plain install records a single "install"
 * segment; a later explicit `tret trace` appends a "trace" segment without a format migration
 * (D5). `tret find` records a "find" segment.
 */
export type CaptureSegment = {
  kind: "install" | "trace" | "find";
  startedAt: string;
  endedAt?: string;
  /** Set when the segment is known to be incomplete; mirrors `completeness` for the segment. */
  partialReason?: string;
};

/** Which backend produced a record and how complete its attribution is. */
export type CaptureInfo = {
  backend: string;
  completeness: CaptureCompleteness;
  segments: CaptureSegment[];
};

/**
 * The kind of node an install owns. Symlinks are recorded by target, never followed.
 * `"unknown"` is reserved for migrated v2 records, which stored paths without a kind; it is never
 * produced by a capture backend, and uninstall treats it as non-removable rather than guessing.
 */
export type OwnedKind = "file" | "directory" | "symlink" | "unknown";

/** A path an install created or now owns, with the content fingerprint to verify before removal. */
export type OwnedEntry = {
  path: AbsolutePath;
  kind: OwnedKind;
  /** Symlink target, recorded instead of following the link; only set when `kind` is "symlink". */
  linkTarget?: AbsolutePath;
  /** sha256 of the installed content; absent for directories and for hash-less heuristic records. */
  installedHash?: string;
};

/** A pre-existing path the install changed, retaining the prior content when a before-image exists. */
export type MutatedEntry = {
  path: AbsolutePath;
  beforeHash?: string;
  installedHash?: string;
  /** Content-addressed blob id for the before-image; only set when backups were enabled (D2). */
  beforeBlob?: string;
};

/** A pre-existing path the install removed, retaining the prior content when a before-image exists. */
export type DeletedEntry = {
  path: AbsolutePath;
  beforeHash?: string;
  beforeBlob?: string;
};

/**
 * Rewrite record shape (plan section 3). Separates ownership (`owned`) from mutation (`mutated`)
 * and deletion (`deleted`), carries capture completeness and privilege explicitly, and never
 * infers ownership from a path's name. Multiple records may claim one path; conflicts are
 * resolved by uninstall planning, not by silently transferring ownership (D4).
 */
export type RecordV3 = {
  /** Stable identifier for the record, independent of the tool name. */
  id: string;
  name: string;
  source: "install" | "find";
  url: string;
  installedAt: string;
  executable: AbsolutePath;
  scriptSha256: string;
  capture: CaptureInfo;
  privilege: Privilege;
  /** Case sensitivity of the record's filesystem at install time (D10). */
  caseSensitive: boolean;
  owned: OwnedEntry[];
  mutated: MutatedEntry[];
  deleted: DeletedEntry[];
};

/** The v3 records file: a version wrapper around `RecordV3` entries. */
export type RecordFileV3 = {
  version: 3;
  records: RecordV3[];
};

// Update check

/** The cached result of the last release check; written at most once a day by `checkForUpdate()`. */
export type UpdateCheckFile = {
  checkedAt: string;
  tag: string;
  outdated: boolean;
};
