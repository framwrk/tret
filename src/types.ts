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
