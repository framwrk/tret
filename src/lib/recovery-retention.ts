import { assertDirectoryIfExists, isErrno } from "./atomic";
import { lstatSync, opendirSync } from "node:fs";
import { chunkOwner } from "./operation-chunks";
import { join } from "node:path";

export type RecoveryLimits = { maxBytes: number; maxEntries: number; maxWorkMs: number };
export const DEFAULT_RECOVERY_LIMITS: Readonly<RecoveryLimits> = Object.freeze({
  maxBytes: 128 * 1024 * 1024,
  maxEntries: 1024,
  maxWorkMs: 30_000,
});
const ENV = {
  maxBytes: "TRET_RECOVERY_MAX_BYTES",
  maxEntries: "TRET_RECOVERY_MAX_ENTRIES",
  maxWorkMs: "TRET_RECOVERY_MAX_WORK_MS",
} as const;
export class RecoveryLimitError extends Error {
  constructor(name: string) {
    super(`${name} requires a positive safe integer`);
    this.name = "RecoveryLimitError";
  }
}
export class RecoveryRetentionError extends Error {
  executionMayHaveStarted = false;
  constructor(reason: string) {
    super(
      `recovery retention refused: ${reason}; inspect or explicitly discard selected evidence, or raise the documented limit`,
    );
    this.name = "RecoveryRetentionError";
  }
}
export function recoveryLimits(env: Record<string, string | undefined> = process.env): RecoveryLimits {
  const limits = { ...DEFAULT_RECOVERY_LIMITS };
  for (const key of Object.keys(ENV) as (keyof RecoveryLimits)[]) {
    const raw = env[ENV[key]];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new RecoveryLimitError(ENV[key]);
    limits[key] = Number(raw);
  }
  return Object.freeze(limits);
}

export type RecoveryEntry = {
  path: string;
  name: string;
  kind: "operation" | "operation-chunk" | "original" | "corrupt" | "staging";
  size: number;
};
const ROOT_EVIDENCE = /^records\.json\.(?:legacy-|corrupt-)/;

/** Counts retained files and interrupted atomic staging, never follows or evicts them. */
export class RecoveryRetention {
  private readonly configured?: RecoveryLimits;
  constructor(
    readonly stateDir: string,
    limits?: RecoveryLimits,
  ) {
    this.configured = limits && Object.freeze({ ...limits });
  }
  get limits(): RecoveryLimits {
    return this.configured ?? recoveryLimits();
  }

  inventory(): RecoveryEntry[] {
    const limits = this.limits;
    const deadline = performance.now() + limits.maxWorkMs;
    const entries: RecoveryEntry[] = [];
    let bytes = 0;
    const check = () => {
      if (performance.now() >= deadline)
        throw new RecoveryRetentionError(`enumeration exceeded ${limits.maxWorkMs} active milliseconds`);
    };
    const scan = (directory: string, root: boolean) => {
      assertDirectoryIfExists(directory);
      let dir;
      try {
        dir = opendirSync(directory, { bufferSize: 32 });
      } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
      try {
        for (;;) {
          check();
          const entry = dir.readSync();
          if (!entry) break;
          if (root && !ROOT_EVIDENCE.test(entry.name)) continue;
          const path = join(directory, entry.name);
          let node;
          try {
            node = lstatSync(path);
          } catch (error) {
            if (isErrno(error, "ENOENT")) continue;
            throw error;
          }
          if (entries.length >= limits.maxEntries) throw new RecoveryRetentionError(`entry limit ${limits.maxEntries}`);
          if (!node.isFile() || !Number.isSafeInteger(node.size))
            throw new RecoveryRetentionError(`unsupported evidence entry: ${path}`);
          bytes += node.size;
          if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes)
            throw new RecoveryRetentionError(`byte limit ${limits.maxBytes}`);
          entries.push({
            path,
            name: entry.name,
            size: node.size,
            kind: !root
              ? entry.name.endsWith(".tmp")
                ? "staging"
                : chunkOwner(entry.name) ? "operation-chunk" : "operation"
              : entry.name.startsWith("records.json.corrupt-")
                ? "corrupt"
                : entry.name.endsWith(".tmp")
                  ? "staging"
                  : "original",
          });
        }
      } finally {
        dir.closeSync();
      }
    };
    assertDirectoryIfExists(this.stateDir);
    scan(this.stateDir, true);
    scan(join(this.stateDir, "operations"), false);
    return entries;
  }

  /** Reserve enough space for the ordinary 16 MiB manifest and its atomic replacement. */
  beforeIntent(): void {
    const entries = this.inventory();
    const limits = this.limits;
    if (entries.length >= limits.maxEntries) throw new RecoveryRetentionError(`entry limit ${limits.maxEntries}`);
    const headroom = Math.min(32 * 1024 * 1024, Math.floor(limits.maxBytes / 2));
    if (entries.reduce((sum, entry) => sum + entry.size, 0) + headroom > limits.maxBytes)
      throw new RecoveryRetentionError(`insufficient checkpoint headroom within ${limits.maxBytes} bytes`);
  }

  beforeWrite(path: string, size: number): void {
    const entries = this.inventory();
    const limits = this.limits;
    if (!entries.some((entry) => entry.path === path) && entries.length >= limits.maxEntries)
      throw new RecoveryRetentionError(`entry limit ${limits.maxEntries}`);
    if (entries.reduce((sum, entry) => sum + entry.size, 0) + size > limits.maxBytes)
      throw new RecoveryRetentionError(`atomic staging would exceed ${limits.maxBytes} bytes`);
  }
}
