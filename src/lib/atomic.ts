// Filesystem primitives shared by Tret's persistence (records and before-image blobs): private
// directories, atomic writes, and reads that treat a missing file as absence rather than an error.
//
// The persistence layers depend on these so a crash can never leave a half-written records or blob
// file in place of the last good one.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Mode for a directory only its owner can read or traverse. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode for a file only its owner can read or write. */
export const PRIVATE_FILE_MODE = 0o600;

const TEMP_SUFFIX = ".tmp";

let tempCounter = 0;

/** Creates `dir` (and parents) owned by the current user, tightening permissions on an existing dir. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dir, PRIVATE_DIR_MODE);
}

/**
 * Reads a file as raw bytes, returning undefined when it does not exist. Any other error (for
 * example a permissions failure) is rethrown, so callers never mistake unreadable data for absence.
 */
export function readFileIfExists(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Writes `data` to `path` atomically: the bytes go to a uniquely named temporary file in the same
 * directory, are flushed to disk, and are renamed over the destination in one step. A reader sees
 * either the previous file or the complete new one, never a partial write, and an interrupted write
 * leaves the destination untouched. `mode` is forced on the temporary file so restrictive
 * permissions survive the rename.
 */
export function writeFileAtomic(path: string, data: Uint8Array | string, mode: number): void {
  ensurePrivateDir(dirname(path));
  const temp = temporaryPath(path);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const fd = openSync(temp, "w", mode);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A temporary path in the same directory as `path`, unique across processes and calls. */
export function temporaryPath(path: string): string {
  tempCounter += 1;
  return `${path}.${process.pid}.${tempCounter}${TEMP_SUFFIX}`;
}

/** Whether a directory entry name is one of this module's temporary files. */
export function isTemporaryName(name: string): boolean {
  return name.endsWith(TEMP_SUFFIX);
}

/** Whether an unknown error carries a specific Node errno code. */
export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
