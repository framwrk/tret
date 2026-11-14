// Filesystem primitives shared by Tret's persistence (records and before-image blobs): private
// directories, atomic writes, and reads that treat a missing file as absence rather than an error.
//
// The persistence layers depend on these so a crash can never leave a half-written records or blob
// file in place of the last good one.

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Mode for a directory only its owner can read or traverse. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode for a file only its owner can read or write. */
export const PRIVATE_FILE_MODE = 0o600;

const TEMP_SUFFIX = ".tmp";

/** Creates `dir` (and parents) owned by the current user, tightening permissions on an existing dir. */
export function ensurePrivateDir(dir: string): void {
  assertDirectoryIfExists(dir);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  assertDirectoryIfExists(dir);
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchmodSync(fd, PRIVATE_DIR_MODE);
  } finally {
    closeSync(fd);
  }
}

/** Checks with lstat; never creates the directory, follows a link, or changes its mode. */
export function assertDirectoryIfExists(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error(`private state directory is not a real directory: ${dir}`);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

/**
 * Reads a file as raw bytes, returning undefined when it does not exist. Any other error (for
 * example a permissions failure) is rethrown, so callers never mistake unreadable data for absence.
 */
export function readFileIfExists(path: string, maxBytes?: number): Uint8Array | undefined {
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) throw new Error(`private state is not a regular file: ${path}`);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const node = fstatSync(fd);
    if (!node.isFile()) throw new Error(`private state is not a regular file: ${path}`);
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid private read limit");
      if (node.size > maxBytes) throw new Error(`private state exceeds ${maxBytes} bytes: ${path}`);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        // One extra byte detects growth beyond the budget without an unbounded readFile allocation.
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
        const count = readSync(fd, chunk, 0, chunk.byteLength, null);
        if (count === 0) return Buffer.concat(chunks, total);
        total += count;
        if (total > maxBytes) throw new Error(`private state exceeds ${maxBytes} bytes: ${path}`);
        chunks.push(chunk.subarray(0, count));
      }
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `data` to `path` atomically: the bytes go to a uniquely named temporary file in the same
 * directory, are flushed to disk, and are renamed over the destination in one step. A reader sees
 * either the previous file or the complete new one, never a partial write, and an interrupted write
 * leaves the destination untouched. `mode` is forced on the temporary file so restrictive
 * permissions survive the rename, and the parent directory is made private first. Errors before
 * rename preserve the destination. A directory-flush error after rename means the replacement may
 * already be visible; callers must inspect current state rather than assume rollback.
 */
export function writeFileAtomic(path: string, data: Uint8Array | string, mode: number): void {
  ensurePrivateDir(dirname(path));
  writeAtomic(path, data, mode);
}

/**
 * Like `writeFileAtomic`, but never changes the permissions of directories that already exist:
 * a missing parent is created private, while an existing one keeps its mode. Restoring a user file
 * under `$HOME` or `~/.config` must not tighten a shared directory that every other program uses.
 */
export function writeFileAtomicPreservingParents(path: string, data: Uint8Array | string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  writeAtomic(path, data, mode);
}

function writeAtomic(path: string, data: Uint8Array | string, mode: number): void {
  const temp = temporaryPath(path);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try {
      writeAndFlush(fd, data, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    flushDirectory(dirname(path));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Creates an original/recovery file once; an existing file or symlink is never overwritten. */
export function writeFileExclusive(path: string, data: Uint8Array | string, mode: number): void {
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try {
      writeAndFlush(fd, data, mode);
    } finally {
      closeSync(fd);
    }
    flushDirectory(dirname(path));
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/** Reused recovery files must also be private and flushed before their source can be replaced. */
export function flushFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`private state is not a regular file: ${path}`);
    fchmodSync(fd, PRIVATE_FILE_MODE);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  flushDirectory(dirname(path));
}

function writeAndFlush(fd: number, data: Uint8Array | string, mode: number): void {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  fchmodSync(fd, mode);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("write made no progress");
    offset += written;
  }
  fsyncSync(fd);
}

export function flushDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A temporary path in the same directory as `path`, unique across processes and calls. */
export function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}${TEMP_SUFFIX}`;
}

/** Whether a directory entry name is one of this module's temporary files. */
export function isTemporaryName(name: string): boolean {
  return name.endsWith(TEMP_SUFFIX);
}

/** Whether an unknown error carries a specific Node errno code. */
export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
