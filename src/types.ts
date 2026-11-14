// Types shared across Tret's commands and library code.
import type { CleanupApproval } from "./lib/cleanup-authority";

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
 * `complete` reports no known capture loss within the bounded scope; `partial` reports lost
 * coverage (daemonized descendants, a uid transition); `heuristic` infers changes without PID
 * attribution. Records carry this so a heuristic macOS record and a complete Linux one stay
 * distinguishable in `tret list` and uninstall output.
 */
export type CaptureCompleteness = "complete" | "partial" | "heuristic";

/** Historical display labels. Window completeness alone now yields `observed`, never authority. */
export type OwnershipConfidence = "proven" | "observed";

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

/** Install capture preferences reused by tracked-tool updates, separate from capture evidence. */
export type CaptureSettings = {
  enabled: boolean;
  backups: {
    enabled: boolean;
    sizeLimitBytes: number;
  };
  observe?: {
    include?: AbsolutePath[];
    exclude?: AbsolutePath[];
  };
};

/**
 * The kind of a candidate node. Symlinks are recorded by target, never followed.
 * `"unknown"` is reserved for migrated v2 records, which stored paths without a kind; it is never
 * produced by a capture backend, and uninstall treats it as non-removable rather than guessing.
 */
export type OwnedKind = "file" | "directory" | "symlink" | "unknown";

/** A historical "owned" candidate and its installed fingerprint; neither field supplies cleanup authority. */
export type OwnedEntry = {
  path: AbsolutePath;
  kind: OwnedKind;
  /** Symlink target, recorded instead of following the link; only set when `kind` is "symlink". */
  linkTarget?: AbsolutePath;
  /** sha256 of the installed content; absent for directories and for legacy records recorded without one. */
  installedHash?: string;
};

/** A pre-existing path the install changed, retaining the prior content when a before-image exists. */
export type MutatedEntry = {
  path: AbsolutePath;
  beforeHash?: string;
  installedHash?: string;
  /** Content-addressed blob id for the before-image; only set when backups were enabled (D2). */
  beforeBlob?: string;
  /** Permission bits (`0o7777` max) before the install changed the path, when the capture knew them. */
  mode?: number;
};

/** A pre-existing path the install removed, retaining the prior content when a before-image exists. */
export type DeletedEntry = {
  path: AbsolutePath;
  beforeHash?: string;
  beforeBlob?: string;
  /** Permission bits (`0o7777` max) the path had before the install removed it, when known. */
  mode?: number;
};

/** A recognized package-manager layout; recognition does not authorize manager execution. */
export type PackageManagerId = "bun" | "npm" | "pnpm" | "yarn";

/**
 * A global package an install registered through a package manager's global mode. Its shared
 * `node_modules` root, lockfile, and manifest are never owned (they are updated by every global
 * install), so these scopes remain unresolved without a verified adapter.
 */
export type ManagedPackage = {
  manager: PackageManagerId;
  /** Package identifier for reporting, e.g. `@scope/name`; never passed to a manager by cleanup. */
  package: string;
  /**
   * Absolute shared root the package's global state lives under (the directory containing the
   * manager's shared `node_modules`), when it is not the manager's fixed home-relative default.
   * npm records it because its global prefix varies per machine (`~/.npm-global`, `~/.local`,
   * `/opt/homebrew`, an nvm tree...); bun's default is fixed, so it stays unset.
   */
  globalRoot?: AbsolutePath;
};

/**
 * Recognition metadata for a first-party managed layout. It supplies no payload inventory or
 * recursive removal authority. Unknown payload stays unresolved; only separately approved ordinary
 * objects outside that scope can participate in an explicitly narrower cleanup request.
 */
export type ManagedInstall = {
  /** Marker kind that identifies the layout, e.g. `pi-managed-install`. */
  kind: string;
  /** Layout name from the marker, e.g. `releases-v1`. */
  layout: string;
  /** Absolute managed root; holds the marker and the (unowned) release payload. */
  root: AbsolutePath;
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
  /** Present on v4 storage snapshots; zero denotes evidence read from a legacy file. */
  revision?: number;
  /** Absent on historical records; read normalization supplies unapproved candidate evidence. */
  evidence?: EffectEvidence[];
  name: string;
  source: "install" | "find";
  url: string;
  installedAt: string;
  executable: AbsolutePath;
  scriptSha256: string;
  /**
   * Arguments passed to the install script after `--`, in order (plan 03 item 3). Preserved so a
   * tracked-tool update can re-run the same installer invocation; absent when the install took none.
   */
  scriptArgs?: string[];
  /** Absent on older records and adopted tools; updates then use the install defaults. */
  captureSettings?: CaptureSettings;
  capture: CaptureInfo;
  privilege: Privilege;
  /** Case sensitivity of the record's filesystem at install time (D10). */
  caseSensitive: boolean;
  owned: OwnedEntry[];
  mutated: MutatedEntry[];
  deleted: DeletedEntry[];
  /**
   * Set when the executable was put on disk by a package manager's global mode. The shared global
   * state stays out of `owned`; full-scope cleanup refuses unverified manager effects.
   */
  managedBy?: ManagedPackage;
  /**
   * Set when a first-party managed layout is recognized. The root/payload remain unresolved;
   * recognizing a marker never authorizes recursive removal.
   */
  managedInstall?: ManagedInstall;
};

/** The v3 records file: a version wrapper around `RecordV3` entries. */
export type RecordFileV3 = {
  version: 3;
  records: RecordV3[];
};

/** A candidate effect, separate from any future object-bound cleanup authorization. */
export type EffectEvidence = {
  id: string;
  path: AbsolutePath;
  section: "owned" | "mutated" | "deleted";
  origin: "legacy-v2" | "legacy-v3" | "capture" | "trace" | "find" | "adoption";
  attribution: "unknown" | "observed";
  beforeImage: "referenced" | "unavailable";
} & ({ authority: "none" } | { authority: "user-approved"; approval: CleanupApproval });

/** Semantic storage boundary: v3 readers must refuse this wrapper. */
export type RecordV4 = RecordV3 & {
  revision: number;
  evidence: EffectEvidence[];
};

export type RecordFileV4 = {
  version: 4;
  /** Monotonic across saves and removals, so delete/recreate cannot revive a stale revision. */
  sequence: number;
  records: RecordV4[];
};

// Update check

/** The cached result of the last release check; written at most once a day by `checkForUpdate()`. */
export type UpdateCheckFile = {
  checkedAt: string;
  tag: string;
  outdated: boolean;
};
