// Types shared across Tret's commands and library code.

// Units

/** Absolute path to a file or folder on disk. */
export type AbsolutePath = string;

/** Last-modified time in milliseconds since the Unix epoch. */
export type MtimeMs = number;

// Snapshots

/** Every file and folder Tret tracks, mapped to its last-modified time. */
export type Snapshot = Map<AbsolutePath, MtimeMs>;
