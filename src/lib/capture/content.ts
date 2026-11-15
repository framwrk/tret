import { CaptureBudget, CaptureBudgetError } from "./budget";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type ContentReadOptions = { budget?: CaptureBudget; maxBytes?: number };
const CHUNK_BYTES = 64 * 1024;

/** Reads only the pinned regular file's bounded initial size; changes during reading invalidate it. */
function content<T>(
  path: string,
  options: ContentReadOptions,
  resource: "backupBytes" | "hashBytes",
  read: (fd: number, size: number, budget: CaptureBudget) => T,
): T | undefined {
  const budget = options.budget ?? new CaptureBudget();
  budget.ensurePhase();
  let fd: number | undefined;
  try {
    budget.check();
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile()) {
      budget.note(`content unavailable for unsupported node: ${path}`);
      return undefined;
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = fstatSync(fd, { bigint: true });
    if (
      !initial.isFile() ||
      initial.dev !== named.dev ||
      initial.ino !== named.ino ||
      initial.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return undefined;
    const size = Number(initial.size);
    if (options.maxBytes !== undefined && size > options.maxBytes) {
      budget.note(`content exceeds per-file byte limit: ${path}`);
      return undefined;
    }
    const result = read(fd, size, budget);
    if (result === undefined) return undefined;
    // Pseudo-files may report size zero while returning bytes. Reserve room for a one-byte EOF
    // probe rather than accepting a prefix as a complete before-image or installed fingerprint.
    if (budget.remaining(resource) < 1) {
      budget.note(`content EOF could not be verified within the byte budget: ${path}`);
      return undefined;
    }
    const extra = readSync(fd, new Uint8Array(1), 0, 1, null);
    budget.consume(resource, extra);
    if (extra !== 0) {
      budget.note(`content exceeds its initial stat size: ${path}`);
      return undefined;
    }
    const final = fstatSync(fd, { bigint: true });
    if (!(["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"] as const).every((key) => initial[key] === final[key])) {
      budget.note(`content changed during reading: ${path}`);
      return undefined;
    }
    budget.check();
    return result;
  } catch (error) {
    if (error instanceof CaptureBudgetError) throw error;
    budget.note(`content unavailable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readBoundedContent(path: string, options: ContentReadOptions = {}): Promise<Uint8Array | undefined> {
  const budget = options.budget ?? new CaptureBudget();
  budget.ensurePhase();
  return content(
    path,
    { ...options, budget, maxBytes: Math.min(options.maxBytes ?? budget.limits.maxBlobBytes, budget.limits.maxBlobBytes) },
    "backupBytes",
    (fd, size) => {
      if (size > budget.remaining("backupBytes")) {
        budget.note(`aggregate backup byte budget exhausted before reading: ${path}`);
        return undefined;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        budget.check();
        const count = readSync(fd, bytes, offset, Math.min(CHUNK_BYTES, size - offset), null);
        if (count === 0) throw new Error("file shrank during backup");
        budget.consume("backupBytes", count);
        offset += count;
      }
      return bytes;
    },
  );
}

export function hashBoundedContentSync(path: string, options: ContentReadOptions = {}): string | undefined {
  const budget = options.budget ?? new CaptureBudget();
  budget.ensurePhase();
  return content(path, { ...options, budget }, "hashBytes", (fd, size) => {
    if (size > budget.remaining("hashBytes")) {
      budget.note(`aggregate fingerprint byte budget exhausted before reading: ${path}`);
      return undefined;
    }
    const hash = new Bun.CryptoHasher("sha256");
    const bytes = new Uint8Array(CHUNK_BYTES);
    let offset = 0;
    while (offset < size) {
      budget.check();
      const count = readSync(fd, bytes, 0, Math.min(bytes.byteLength, size - offset), null);
      if (count === 0) throw new Error("file shrank during hashing");
      budget.consume("hashBytes", count);
      hash.update(bytes.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  });
}

export async function hashBoundedContent(path: string, options: ContentReadOptions = {}): Promise<string | undefined> {
  return hashBoundedContentSync(path, options);
}
