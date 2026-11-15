import type { AbsolutePath, OwnedKind } from "../../../types";
import { CaptureBudget, CaptureBudgetError } from "../budget";
import { EXCLUDED_PATHS, isExcludedDirName, isSensitiveBackupPath } from "../../../constants";
import { basename, dirname, join } from "node:path";
import { hashBoundedContent, readBoundedContent } from "../content";
import { lstat, opendir, readlink, realpath } from "node:fs/promises";
import type { BackupPolicy } from "../normalize";
import type { BlobId } from "../../storage";
import type { CaptureBaselineEntry } from "../backend";
import type { ContentReadOptions } from "../content";
import { createHash } from "node:crypto";
import { normalizeAbsolutePath } from "./paths";
import { privateStateFilter } from "../self-state";
import { scanPresence } from "../scan-coverage";

/**
 * The before/after metadata `reconstruct.ts` needs for one path. It mirrors the journal metadata
 * union (`FileMetadata`/`DirectoryMetadata`/`SymlinkMetadata`) plus `missing`, and is produced by an
 * injectable `FsInspector` so the pipeline can be tested without touching a real filesystem.
 */
export type NodeInfo =
  | { kind: "file"; hash?: string; size?: number; mode?: number; mtimeMs?: number }
  | { kind: "directory"; mode?: number }
  | { kind: "symlink"; target: AbsolutePath; mode?: number }
  | { kind: "missing" }
  | { kind: "unknown"; reason: string };

export interface FsInspector {
  /**
   * Inspects `path` without following symlinks. `hash` is false when only existence/kind is needed
   * (a baseline pass), which avoids reading file contents.
   */
  inspect(path: AbsolutePath, options?: { hash?: boolean }): Promise<NodeInfo>;
  /**
   * Resolves `path` as far as it exists on disk: `realpath` of the deepest existing ancestor,
   * rejoined with the remaining (not yet existing) tail and lexically normalized. This is how the
   * capture pipeline checks that a traced path's parent does not leave the observe roots through a
   * symlinked component.
   */
  resolve(path: AbsolutePath): Promise<AbsolutePath>;
}

/** Reads the real filesystem; symlinks are reported by target and never followed. */
export class RealFsInspector implements FsInspector {
  private readonly maxHashBytes: number;
  private readonly budget: CaptureBudget;

  constructor(options: { maxHashBytes?: number; budget?: CaptureBudget } = {}) {
    this.budget = options.budget ?? new CaptureBudget();
    this.maxHashBytes = options.maxHashBytes ?? this.budget.limits.maxHashBytes;
  }

  async inspect(path: AbsolutePath, options: { hash?: boolean } = {}): Promise<NodeInfo> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unknown", reason: String(error) };
    }

    const mode = stats.mode & 0o7777;
    if (stats.isSymbolicLink()) {
      try {
        return { kind: "symlink", target: await readlink(path), mode };
      } catch (error) {
        return { kind: "unknown", reason: String(error) };
      }
    }
    if (stats.isDirectory()) return { kind: "directory", mode };
    if (!stats.isFile()) return { kind: "unknown", reason: "unsupported node type" };

    const info: NodeInfo = { kind: "file", size: stats.size, mode, mtimeMs: stats.mtimeMs };
    if (options.hash !== false && stats.size <= this.maxHashBytes) {
      info.hash = await hashBoundedContent(path, { maxBytes: this.maxHashBytes, budget: this.budget });
    }
    return info;
  }

  /**
   * Walks up from `path` until an ancestor resolves, then rejoins the untouched tail. The tail has
   * no symlinked components (it does not exist yet), so re-joining it is kernel-accurate; the final
   * join is lexically normalized because the tail may still contain `..` segments.
   */
  async resolve(path: AbsolutePath): Promise<AbsolutePath> {
    const tail: string[] = [];
    let candidate = path;
    for (;;) {
      try {
        const resolved = await realpath(candidate);
        return finalizeResolved(tail.length === 0 ? resolved : join(resolved, ...tail), path);
      } catch {
        const parent = dirname(candidate);
        if (parent === candidate) return finalizeResolved(path, path);
        tail.unshift(basename(candidate));
        candidate = parent;
      }
    }
  }
}

/** Lexically normalizes a resolved path; the raw path is the fallback for an unnormalizable input. */
function finalizeResolved(resolved: string, raw: AbsolutePath): AbsolutePath {
  return normalizeAbsolutePath(resolved) ?? raw;
}

/** In-memory inspector for tests: pre-seed node metadata and symlinked-ancestor resolutions. */
export class FakeFsInspector implements FsInspector {
  private readonly nodes: Map<AbsolutePath, NodeInfo>;
  private readonly resolutions: Map<AbsolutePath, AbsolutePath>;

  constructor(nodes: Iterable<[AbsolutePath, NodeInfo]> = []) {
    this.nodes = new Map(nodes);
    this.resolutions = new Map();
  }

  set(path: AbsolutePath, info: NodeInfo): this {
    this.nodes.set(path, info);
    return this;
  }

  /** Seeds what `resolve` reports for a path or one of its ancestors (a symlink target). */
  setResolution(path: AbsolutePath, resolved: AbsolutePath): this {
    this.resolutions.set(path, resolved);
    return this;
  }

  async inspect(path: AbsolutePath): Promise<NodeInfo> {
    return this.nodes.get(path) ?? { kind: "missing" };
  }

  /** Resolves through the longest seeded ancestor; an unseeded path resolves to its normalized self. */
  async resolve(path: AbsolutePath): Promise<AbsolutePath> {
    const tail: string[] = [];
    let candidate = path;
    for (;;) {
      const resolved = this.resolutions.get(candidate);
      if (resolved !== undefined) {
        return normalizeAbsolutePath(join(resolved, ...tail)) ?? resolved;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return normalizeAbsolutePath(path) ?? path;
      tail.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * A baseline of what existed before the install window: it tells a create from an overwrite and
 * describes a removed node. By default it is existence/kind only and reads no file content, so it
 * cannot become the global content diff the rewrite replaces. When backups are enabled (D2) the walk
 * also reads each eligible file once, so the pre-window hash/size/mode travel with the baseline and
 * `reconstruct.ts` can attach them as a mutation's or deletion's `before`.
 */
export interface Baseline {
  readonly diagnostics?: readonly string[];
  state?(path: AbsolutePath): "present" | "absent" | "unknown";
  /** Whether the path existed before the window started. */
  existed(path: AbsolutePath): boolean;
  /** The node kind known before the window, when the path existed. */
  kind(path: AbsolutePath): OwnedKind | undefined;
  /** The full pre-window node, when the baseline captured one (backups enabled); `missing` is never stored. */
  metadata(path: AbsolutePath): NodeInfo | undefined;
}

/** An in-memory baseline; `entries` maps absolute paths to a kind or to captured node metadata. */
export class MemoryBaseline implements Baseline {
  private readonly entries: Map<AbsolutePath, OwnedKind | NodeInfo>;
  private readonly absentRoots = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly uncertain = new Set<string>();
  private readonly excluded = new Set<string>();
  readonly diagnostics: string[] = [];

  constructor(entries: Iterable<[AbsolutePath, OwnedKind]> = []) {
    this.entries = new Map(entries);
  }

  existed(path: AbsolutePath): boolean {
    return this.entries.has(path);
  }

  state(path: string): "present" | "absent" | "unknown" {
    return scanPresence(path, this.entries, { completeDirectories: this.completed, absentRoots: this.absentRoots, unknownPaths: this.uncertain, excludedPaths: this.excluded });
  }
  missing(path: string): void { this.absentRoots.add(path); }
  exclude(path: string): void { this.excluded.add(path); }
  complete(path: string): void { this.completed.add(path); }
  unknown(path: string, reason: string): void {
    this.uncertain.add(path);
    if (this.diagnostics.length < 32) this.diagnostics.push(`${path}: ${reason}`);
  }

  kind(path: AbsolutePath): OwnedKind | undefined {
    const entry = this.entries.get(path);
    if (entry === undefined || entry === "unknown") return undefined;
    return typeof entry === "string" ? entry : kindOf(entry);
  }

  metadata(path: AbsolutePath): NodeInfo | undefined {
    const entry = this.entries.get(path);
    return entry === undefined || typeof entry === "string" ? undefined : entry;
  }

  set(path: AbsolutePath, kind: OwnedKind): void {
    this.entries.set(path, kind);
  }

  snapshot(): CaptureBaselineEntry[] {
    const nodes: CaptureBaselineEntry[] = [...this.entries].map(([path, entry]) => {
      const state = { presence: "present" as const, ...(this.kind(path) === "directory" ? { childrenComplete: this.completed.has(path) } : {}) };
      if (typeof entry === "string") return { path, kind: entry, ...state };
      return {
        path, kind: kindOf(entry), ...state,
        ...("mode" in entry && entry.mode !== undefined ? { mode: entry.mode } : {}),
        ...(entry.kind === "file" && entry.hash ? { hash: entry.hash } : {}),
        ...(entry.kind === "symlink" ? { linkTarget: entry.target } : {}),
      };
    });
    for (const path of this.absentRoots) if (!this.entries.has(path)) nodes.push({ path, kind: "unknown", presence: "absent" });
    for (const path of this.uncertain) if (!this.entries.has(path)) nodes.push({ path, kind: "unknown", presence: "unknown" });
    return nodes;
  }

  /** Records full pre-window metadata (only a backups-enabled walk does this). */
  setNode(path: AbsolutePath, info: Exclude<NodeInfo, { kind: "missing" }>): void {
    this.entries.set(path, info);
  }
}

/** Options for the pre-window baseline walk. */
export type BaselineOptions = {
  budget?: CaptureBudget;
  home?: string;
  /** Before-image policy (D2). File content is read only when this reports `enabled`. */
  backups?: BackupPolicy;
  /** Filesystem inspector; defaults to the real one. Tests inject fakes. */
  inspector?: FsInspector;
  /** Reads a file's bytes for a before-image; injected in tests. Defaults to the real filesystem. */
  read?: (path: AbsolutePath, options?: ContentReadOptions) => Promise<Uint8Array | undefined>;
};

/** The baseline plus any before-image bytes the walk read for it. */
export type CapturedBaseline = {
  baseline: MemoryBaseline;
  /** Pre-window content keyed by its sha256 content address (the blob id); empty unless backups are enabled. */
  beforeImages: Map<BlobId, Uint8Array>;
};

/**
 * Walks the observe roots once and records which paths already existed. With backups off this is
 * existence-only — a `readdir` per directory and no file bytes read — so it cannot become the global
 * content diff the rewrite is replacing. When backups are enabled (D2), each eligible regular file is
 * also read once, for its before-image. Either way the walk is bounded by the roots the platform
 * hands in, and it skips the same churn directories the snapshot walk does (see `EXCLUDED_DIR_NAMES`)
 * and the home-relative `EXCLUDED_PATHS` list (`Documents`, `Downloads`, `.npm`, …), so a multi-GB
 * cache such as a runner's `/opt/hostedtoolcache` is recorded as one entry, never walked.
 * Overlapping roots share a visited-path set, so the same file is never read twice for backups.
 */
export async function captureBaseline(roots: AbsolutePath[], options: BaselineOptions = {}): Promise<CapturedBaseline> {
  const budget = options.budget ?? new CaptureBudget();
  budget.ensurePhase();
  const inspector = options.inspector ?? new RealFsInspector({ budget });
  const baseline = new MemoryBaseline();
  const beforeImages = new Map<BlobId, Uint8Array>();
  const visited = new Set<AbsolutePath>();
  const excluded = new Set(EXCLUDED_PATHS.map((path) => join(options.home ?? process.env.HOME ?? "", path)));
  const privateState = privateStateFilter();
  const backups = options.backups;
  const backup: BackupCapture | undefined =
    backups?.enabled === true
      ? { sizeLimitBytes: backups.sizeLimitBytes, read: options.read ?? readBoundedContent, images: beforeImages, budget }
      : undefined;

  for (const root of [...new Set(roots)].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    if (visited.has(root)) continue;
    if (privateState(root)) { baseline.exclude(root); continue; }
    budget.inspect(root);
    const info = await inspector.inspect(root, { hash: false });
    if (info.kind === "missing") { baseline.missing(root); continue; }
    if (info.kind === "unknown") { baseline.unknown(root, info.reason); continue; }
    if (info.kind === "file" && backup !== undefined) {
      visited.add(root);
      await recordFile(root, info, baseline, backup);
    } else {
      baseline.set(root, kindOf(info));
    }
    if (info.kind === "directory") await walk(root, baseline, inspector, backup, visited, excluded, privateState, budget);
    else visited.add(root);
  }
  budget.check();
  for (const reason of baseline.diagnostics) budget.note(`baseline coverage unknown: ${reason}`);
  return { baseline, beforeImages };
}

/** What a backups-enabled walk uses to turn pre-existing files into before-images. */
type BackupCapture = {
  budget: CaptureBudget;
  sizeLimitBytes: number;
  read: (path: AbsolutePath, options?: ContentReadOptions) => Promise<Uint8Array | undefined>;
  images: Map<BlobId, Uint8Array>;
};

async function walk(
  dir: AbsolutePath,
  baseline: MemoryBaseline,
  inspector: FsInspector,
  backup: BackupCapture | undefined,
  visited: Set<AbsolutePath>,
  excluded: ReadonlySet<AbsolutePath>,
  privateState: (path: string) => boolean,
  budget: CaptureBudget,
  depth = 0,
): Promise<void> {
  budget.depth(depth);
  if (visited.has(dir)) return;
  visited.add(dir);

  let directory;
  try {
    directory = await opendir(dir, { bufferSize: 32 });
    for await (const entry of directory) {
    budget.check();
    const path = join(dir, entry.name);
    if (visited.has(path)) continue;
    if (excluded.has(path) || privateState(path)) { baseline.exclude(path); continue; }
    budget.inspect(path);
    if (entry.isDirectory()) {
      baseline.set(path, "directory");
      // Record excluded directories but never descend, so shared churn trees cost one entry and no
      // before-image reads. An explicit root nested below this directory can still be walked separately.
      if (!isExcludedDirName(entry.name)) await walk(path, baseline, inspector, backup, visited, excluded, privateState, budget, depth + 1);
      else visited.add(path);
    } else {
      visited.add(path);
      if (entry.isFile() && backup !== undefined) {
        await recordFile(path, await inspector.inspect(path, { hash: false }), baseline, backup);
        continue;
      }
      if (entry.isSymbolicLink()) baseline.set(path, "symlink");
      else if (entry.isFile()) baseline.set(path, "file");
      else baseline.unknown(path, "unsupported node type");
    }
    }
    baseline.complete(dir);
  } catch (error) {
    if (error instanceof CaptureBudgetError) throw error;
    baseline.unknown(dir, String(error));
  }
}

/**
 * Records one existing regular file. With backups enabled the file is read once: within the size
 * limit its bytes become a before-image under their sha256 content address, and the pre-window hash,
 * size, mode, and mtime travel in the baseline so a later overwrite or deletion can be restored. An
 * over-limit, unreadable, or sensitive file (key material, credential stores) stays kind-only: the
 * change is still recorded, just not restorable.
 */
async function recordFile(path: AbsolutePath, info: NodeInfo, baseline: MemoryBaseline, backup: BackupCapture): Promise<void> {
  if (
    info.kind !== "file" ||
    info.size === undefined ||
    info.size > backup.sizeLimitBytes ||
    isSensitiveBackupPath(path)
  ) {
    baseline.set(path, kindOf(info));
    return;
  }
  const used = backup.budget.used.backupBytes;
  const bytes = await backup.read(path, { budget: backup.budget, maxBytes: Math.min(backup.sizeLimitBytes, backup.budget.limits.maxBlobBytes) });
  if (bytes === undefined || bytes.byteLength > backup.sizeLimitBytes) {
    baseline.set(path, "file");
    return;
  }
  if (used === backup.budget.used.backupBytes && !backup.budget.tryConsume("backupBytes", bytes.byteLength)) {
    baseline.set(path, "file"); return;
  }
  if (!backup.budget.tryConsume("hashBytes", bytes.byteLength)) { baseline.set(path, "file"); return; }
  const hash = createHash("sha256").update(bytes).digest("hex");
  backup.images.set(hash, bytes);
  baseline.setNode(path, { kind: "file", hash, size: info.size, mode: info.mode, mtimeMs: info.mtimeMs });
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
    case "unknown":
      return "unknown";
  }
}
