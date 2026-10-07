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

// Update check

/** The cached result of the last release check; written at most once a day by `checkForUpdate()`. */
export type UpdateCheckFile = {
  checkedAt: string;
  tag: string;
  outdated: boolean;
};
