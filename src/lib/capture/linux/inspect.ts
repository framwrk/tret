import type { AbsolutePath, OwnedKind } from "../../../types";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The before/after metadata `reconstruct.ts` needs for one path. It mirrors the journal metadata
 * union (`FileMetadata`/`DirectoryMetadata`/`SymlinkMetadata`) plus `missing`, and is produced by an
 * injectable `FsInspector` so the pipeline can be tested without touching a real filesystem.
 */
export type NodeInfo =
  | { kind: "file"; hash?: string; size?: number; mode?: number; mtimeMs?: number }
  | { kind: "directory"; mode?: number }
  | { kind: "symlink"; target: AbsolutePath; mode?: number }
  | { kind: "missing" };

export interface FsInspector {
  /**
   * Inspects `path` without following symlinks. `hash` is false when only existence/kind is needed
   * (a baseline pass), which avoids reading file contents.
   */
  inspect(path: AbsolutePath, options?: { hash?: boolean }): Promise<NodeInfo>;
}

/** Reads the real filesystem; symlinks are reported by target and never followed. */
export class RealFsInspector implements FsInspector {
  private readonly maxHashBytes: number;

  constructor(options: { maxHashBytes?: number } = {}) {
    this.maxHashBytes = options.maxHashBytes ?? 64 * 1024 * 1024;
  }

  async inspect(path: AbsolutePath, options: { hash?: boolean } = {}): Promise<NodeInfo> {
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      return { kind: "missing" };
    }

    const mode = stats.mode & 0o7777;
    if (stats.isSymbolicLink()) {
      try {
        return { kind: "symlink", target: await readlink(path), mode };
      } catch {
        return { kind: "missing" };
      }
    }
    if (stats.isDirectory()) return { kind: "directory", mode };
    if (!stats.isFile()) return { kind: "missing" };

    const info: NodeInfo = { kind: "file", size: stats.size, mode, mtimeMs: stats.mtimeMs };
    if (options.hash !== false && stats.size <= this.maxHashBytes) {
      try {
        info.hash = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } catch {
        // Unreadable content stays hash-less; the mutation is still recorded, just not restorable.
      }
    }
    return info;
  }
}

/** In-memory inspector for tests: pre-seed node metadata keyed by absolute path. */
export class FakeFsInspector implements FsInspector {
  private readonly nodes: Map<AbsolutePath, NodeInfo>;

  constructor(nodes: Iterable<[AbsolutePath, NodeInfo]> = []) {
    this.nodes = new Map(nodes);
  }

  set(path: AbsolutePath, info: NodeInfo): this {
    this.nodes.set(path, info);
    return this;
  }

  async inspect(path: AbsolutePath): Promise<NodeInfo> {
    return this.nodes.get(path) ?? { kind: "missing" };
  }
}

/**
 * A baseline of what existed before the install window, used only to tell a create from an
 * overwrite and to describe a removed node's kind. It stores no content: with backups off (D2) a
 * before-image is not available anyway, and an existence set is far cheaper than hashing a $HOME.
 */
export interface Baseline {
  /** Whether the path existed before the window started. */
  existed(path: AbsolutePath): boolean;
  /** The node kind known before the window, when the path existed. */
  kind(path: AbsolutePath): OwnedKind | undefined;
}

/** An in-memory baseline; `entries` maps absolute paths to a kind (or "missing" is simply absent). */
export class MemoryBaseline implements Baseline {
  private readonly entries: Map<AbsolutePath, OwnedKind | "unknown">;

  constructor(entries: Iterable<[AbsolutePath, OwnedKind | "unknown"]> = []) {
    this.entries = new Map(entries);
  }

  existed(path: AbsolutePath): boolean {
    return this.entries.has(path);
  }

  kind(path: AbsolutePath): OwnedKind | undefined {
    const kind = this.entries.get(path);
    return kind === undefined || kind === "unknown" ? undefined : kind;
  }

  set(path: AbsolutePath, kind: OwnedKind): void {
    this.entries.set(path, kind);
  }
}

/**
 * Walks the observe roots once and records which paths already existed. This is deliberately
 * existence-only: it costs a `lstat` per path and never reads file bytes, so it cannot become the
 * global content diff the rewrite is replacing. It is bounded by the roots the platform hands in.
 */
export async function captureBaseline(roots: AbsolutePath[]): Promise<MemoryBaseline> {
  const baseline = new MemoryBaseline();
  for (const root of roots) {
    const info = await new RealFsInspector().inspect(root, { hash: false });
    if (info.kind === "missing") continue;
    baseline.set(root, kindOf(info));
    if (info.kind === "directory") await walk(root, baseline);
  }
  return baseline;
}

async function walk(dir: AbsolutePath, baseline: MemoryBaseline): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const kind: OwnedKind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
    baseline.set(path, kind);
    if (entry.isDirectory()) await walk(path, baseline);
  }
}

function kindOf(info: NodeInfo): OwnedKind {
  switch (info.kind) {
    case "file":
      return "file";
    case "directory":
      return "directory";
    case "symlink":
      return "symlink";
    case "missing":
      return "unknown";
  }
}
