import { PRIVATE_FILE_MODE, ensurePrivateDir, flushDirectory } from "./atomic";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dlopen, toArrayBuffer } from "bun:ffi";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const operations = new AsyncLocalStorage<ReadonlyMap<string, Lease>>();

type Lease = { token: string; held: boolean; fd: number };

export class OperationLockedError extends Error {
  constructor(readonly path: string) {
    super(`another operation holds the store lease: ${path}`);
    this.name = "OperationLockedError";
  }
}

/** No fallback to a timestamp lease: unsupported kernel locking refuses mutations. */
function kernelLock() {
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: ["i32", "i32"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    });
    return {
      flock: library.symbols.flock,
      errno: () => {
        const pointer = library.symbols.__error();
        if (pointer === null) throw new Error("cannot read kernel lock error");
        return new Int32Array(toArrayBuffer(pointer, 0, 4))[0];
      },
      close: library.close,
      wouldBlock: 35,
    };
  }
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      flock: { args: ["i32", "i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    });
    return {
      flock: library.symbols.flock,
      errno: () => {
        const pointer = library.symbols.__errno_location();
        if (pointer === null) throw new Error("cannot read kernel lock error");
        return new Int32Array(toArrayBuffer(pointer, 0, 4))[0];
      },
      close: library.close,
      wouldBlock: 11,
    };
  }
  throw new Error(`operation locking is unsupported on ${process.platform}`);
}

/**
 * One lease spans a command's reads, capture, target actions and persistence. Nested internal
 * calls on the same store reuse it; independent async callers and other processes contend.
 * The stable file is never removed. The kernel releases the lock when its descriptor closes,
 * including after SIGKILL. Durable unfinished operations are a separate recovery decision.
 */
export async function withOperationLease<T>(
  stateDir: string,
  work: (token: string) => Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  const path = resolve(stateDir, "operation.lock");
  const parent = operations.getStore();
  const active = parent?.get(path);
  if (active?.held) return work(active.token);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("invalid operation lock timeout");

  ensurePrivateDir(dirname(path));
  const native = kernelLock();
  let fd: number | undefined;
  let held = false;
  let lease: Lease | undefined;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, PRIVATE_FILE_MODE);
    const node = fstatSync(fd, { bigint: true });
    if (
      !node.isFile() ||
      node.nlink !== 1n ||
      (process.getuid && process.getuid() !== 0 && node.uid !== BigInt(process.getuid()))
    ) {
      throw new Error(`operation lease must be an owner-held regular file without aliases: ${path}`);
    }
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (native.flock(fd, LOCK_EX | LOCK_NB) === 0) {
        held = true;
        break;
      }
      const errno = native.errno();
      if (errno === 4) continue; // EINTR: no lock was acquired.
      if (errno !== native.wouldBlock) throw new Error(`kernel operation lock failed (errno ${errno}): ${path}`);
      if (performance.now() >= deadline) throw new OperationLockedError(path);
      await Bun.sleep(Math.min(25, Math.max(1, deadline - performance.now())));
    }
    const named = lstatSync(path, { bigint: true });
    if (node.dev !== named.dev || node.ino !== named.ino || !named.isFile()) {
      throw new Error(`operation lease name changed while acquiring it: ${path}`);
    }
    const token = randomUUID();
    const bytes = new TextEncoder().encode(JSON.stringify({ pid: process.pid, token }) + "\n");
    fchmodSync(fd, PRIVATE_FILE_MODE);
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (written <= 0) throw new Error("operation lease write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    flushDirectory(dirname(path));
    const context = new Map(parent);
    lease = { token, held: true, fd };
    context.set(path, lease);
    return await operations.run(context, () => work(token));
  } finally {
    if (lease) lease.held = false;
    if (fd !== undefined) {
      try {
        if (held) native.flock(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    }
    native.close();
  }
}

/** Used by durable-operation APIs to reject intents written outside the enclosing lease. */
export function currentOperationToken(stateDir: string): string | undefined {
  const lease = operations.getStore()?.get(resolve(stateDir, "operation.lock"));
  return lease?.held ? lease.token : undefined;
}

/** Only the foreground supervisor inherits this descriptor; external code receives it closed. */
export function currentOperationDescriptor(stateDir: string): number | undefined {
  const lease = operations.getStore()?.get(resolve(stateDir, "operation.lock"));
  return lease?.held ? lease.fd : undefined;
}
