import { CaptureBudget, CaptureBudgetError } from "../budget";
import { type Dir, type Stats, lstatSync, opendirSync, readlinkSync } from "node:fs";
import type { FileMetadata, JournalEventInput } from "../events";
import { hashBoundedContent, readBoundedContent } from "../content";
import { newScanCoverage, scanPresence } from "../scan-coverage";
import type { AbsolutePath } from "../../../types";
import type { ContentReadOptions } from "../content";
import type { ScanCoverage } from "../scan-coverage";

/**
 * The scoped-snapshot engine behind the macOS heuristic fallback (D1). It is deliberately small and
 * platform-neutral in shape: walk bounded roots twice, diff stamps, hash what changed. It never
 * claims process attribution and never follows symlinks.
 */

/** Kind of node the scoped fallback observes. Symlinks are recorded by target, never followed. */
export type ScopedNodeKind = "file" | "directory" | "symlink";

/** One observed node: its stamp plus, for files, a content hash once one has been computed. */
export type ScopedNode = {
  path: AbsolutePath;
  kind: ScopedNodeKind;
  /** lstat size in bytes. */
  size: number;
  mtimeMs: number;
  /** Permission bits only (`0o7777`), so file-type bits never read as a mode change. */
  mode: number;
  inode: number;
  /** Symlink target as stored, when `kind` is "symlink". */
  linkTarget?: AbsolutePath;
  /** sha256 of the content, filled for files created or whose stamps changed. */
  hash?: string;
  childrenComplete?: boolean;
};

/** A bounded snapshot of one or more roots, plus any roots that could not be read. */
export type ScopedSnapshot = {
  /** Case-correct key to node (D10). */
  entries: Map<string, ScopedNode>;
  /** Roots that exist but could not be scanned; coverage is incomplete when non-empty. */
  errors: string[];
  absentRoots?: string[];
  coverage?: ScanCoverage;
};

/**
 * Pruning rules for one observed root's subtree. A root with no bounds is scanned whole, so the
 * engine's default "the roots are the only bound" behavior is unchanged for every existing subdir
 * root. The macOS `$HOME` root supplies these to reuse the shared skip rules (defect #3).
 */
export type ScopedRootBounds = {
  /** Absolute paths neither recorded nor descended; applies to files and directories. */
  excludePaths?: ReadonlySet<AbsolutePath>;
  /** Directory base names pruned at any depth under the root (files keep their name). */
  excludeDirNames?: ReadonlySet<string>;
  /** Directory base names matching this pattern are pruned at any depth under the root. */
  excludeDirNamePattern?: RegExp;
};

export type ScopedScanOptions = {
  budget?: CaptureBudget;
  /** Whether path comparison is case-sensitive (D10). */
  caseSensitive: boolean;
  /**
   * Optional path predicate; a matching node is neither recorded nor descended. The macOS backend
   * supplies `isVolatileChurnPath` so known churn shapes inside a kept root are invisible. The
   * default (no predicate) still has no exclusion list: the roots are the bound.
   */
  skip?: (path: AbsolutePath) => boolean;
  /**
   * Per-root pruning, keyed by the exact root path. A root without an entry is unbounded, so adding
   * the `$HOME` root does not change how the existing subdir roots are scanned.
   */
  rootBounds?: ReadonlyMap<AbsolutePath, ScopedRootBounds>;
};

/** The comparison key for a path; mirrors journal normalization so both agree on identity (D10). */
export function scopedPathKey(path: AbsolutePath, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase();
}

/**
 * Walks every root and records each node's stamp without following symlinks. A root that does not
 * exist is not an error (an installer may create it); a root that exists but cannot be read is. The
 * roots are the only bound by default (plan section 2): a caller-supplied `skip` drops known churn
 * shapes (defect #2), and a root may opt into `ScopedRootBounds` so adding `$HOME` stays a bounded
 * scan instead of a global one (defect #3).
 */
export function scanScopedRoots(roots: Iterable<AbsolutePath>, options: ScopedScanOptions): ScopedSnapshot {
  const entries = new Map<string, ScopedNode>();
  const errors: string[] = [];
  const absentRoots: string[] = [];
  const coverage = newScanCoverage();
  const budget = options.budget ?? new CaptureBudget();
  budget.ensurePhase();
  const effective = { ...options, budget };
  for (const root of [...new Set(roots)].sort((a, b) => b.length - a.length || a.localeCompare(b)))
    scanNode(root, entries, errors, effective, true, options.rootBounds?.get(root), absentRoots, 0, coverage);
  budget.check();
  return { entries, errors, coverage, ...(absentRoots.length ? { absentRoots } : {}) };
}

function scanNode(
  path: AbsolutePath,
  entries: Map<string, ScopedNode>,
  errors: string[],
  options: ScopedScanOptions,
  isRoot: boolean,
  bounds?: ScopedRootBounds,
  absentRoots?: string[],
  depth = 0,
  coverage?: ScanCoverage,
): void {
  options.budget?.depth(depth);
  const key = scopedPathKey(path, options.caseSensitive);
  if (entries.has(key)) return;
  options.budget?.inspect(path);
  if (options.skip?.(path)) { coverage?.unknownPaths.add(key); return; }

  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    // A missing root is expected; the installer may create it. Only a real read failure is coverage loss.
    if (isRoot && (error as NodeJS.ErrnoException).code === "ENOENT") {
      absentRoots?.push(path);
      coverage?.absentRoots.add(key);
    } else {
      coverage?.unknownPaths.add(key);
      if (errors.length < 32) errors.push(`${path}: ${describe(error)}`);
    }
    return;
  }

  const node = toScopedNode(path, stat);
  if (!node || (node.kind === "symlink" && node.linkTarget === undefined)) {
    coverage?.unknownPaths.add(key);
    if (errors.length < 32) errors.push(`${path}: unsupported or unreadable node`);
    return;
  }
  if (!isRoot && bounds !== undefined && boundsExclude(path, node.kind === "directory", bounds)) { coverage?.unknownPaths.add(key); return; }
  entries.set(scopedPathKey(path, options.caseSensitive), node);
  if (node.kind !== "directory") return;

  let directory: Dir | undefined;
  try {
    directory = opendirSync(path, { bufferSize: 32 });
    for (;;) {
      options.budget?.check();
      const entry = directory.readSync();
      if (!entry) break;
      scanNode(`${path}/${entry.name}`, entries, errors, options, false, bounds, absentRoots, depth + 1, coverage);
    }
    node.childrenComplete = true;
    coverage?.completeDirectories.add(key);
  } catch (error) {
    if (error instanceof CaptureBudgetError) throw error;
    coverage?.unknownPaths.add(key);
    if (errors.length < 32) errors.push(`${path}: ${describe(error)}`);
  } finally {
    directory?.closeSync();
  }
}

/**
 * Whether a child node is pruned by a root's bounds. Absolute-path exclusions cover files and
 * directories; name and pattern exclusions apply only to directories, so a file named `build` or
 * `cache.log` is still tracked (matching the legacy `EXCLUDED_DIR_NAMES` rule).
 */
function boundsExclude(path: AbsolutePath, isDirectory: boolean, bounds: ScopedRootBounds): boolean {
  if (bounds.excludePaths?.has(path) === true) return true;
  if (!isDirectory) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return bounds.excludeDirNames?.has(name) === true || bounds.excludeDirNamePattern?.test(name) === true;
}

function toScopedNode(path: AbsolutePath, stat: Stats): ScopedNode | undefined {
  const base = { path, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o7777, inode: stat.ino };
  if (stat.isSymbolicLink()) return { ...base, kind: "symlink", linkTarget: readLinkTarget(path) };
  if (stat.isDirectory()) return { ...base, kind: "directory" };
  if (stat.isFile()) return { ...base, kind: "file" };
  return undefined;
}

function readLinkTarget(path: AbsolutePath): AbsolutePath | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Whether a file's stamp changed: size, mtime, or inode. Content is only hashed after this. */
export function fileStampChanged(before: ScopedNode, after: ScopedNode): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.inode !== after.inode;
}

/**
 * Files to fingerprint on close, including files with a start fingerprint from an opt-in backup.
 */
export function filesToHash(before: ScopedSnapshot, after: ScopedSnapshot): AbsolutePath[] {
  const paths: AbsolutePath[] = [];
  for (const [key, node] of after.entries) {
    if (node.kind !== "file") continue;
    const prior = before.entries.get(key);
    if (prior === undefined || prior.kind !== "file" || prior.hash !== undefined || fileStampChanged(prior, node)) paths.push(node.path);
  }
  return paths.sort();
}

/** sha256 of a file's content, or undefined when it cannot be read. */
export async function hashFile(path: AbsolutePath, options?: ContentReadOptions): Promise<string | undefined> {
  return hashBoundedContent(path, options);
}

/** sha256 hex of `bytes`, the content address used for before-images and record hashes (D2). */
export function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Reads a whole file as bytes, or undefined when it cannot be read. Callers bound the size first. */
export async function readFileBytes(path: AbsolutePath, options?: ContentReadOptions): Promise<Uint8Array | undefined> {
  return readBoundedContent(path, options);
}

/**
 * Turns two scoped snapshots into journal events. The events carry no `pid`: the fallback cannot
 * attribute a change to a process, which is exactly why its completeness is "heuristic".
 *
 * Ordering rules that make normalization come out right:
 * - removals before creations, so a replaced path (kind or symlink-target change) reads as
 *   delete-then-create (a mutation) rather than create-then-delete (which normalization cancels);
 * - parents before children within each group, because a parent path sorts before its descendants;
 * - a mode change before a content write, so a file changed both ways collapses to one mutation.
 */
export function diffScopedSnapshots(before: ScopedSnapshot, after: ScopedSnapshot, budget?: CaptureBudget): JournalEventInput[] {
  const events: JournalEventInput[] = [];
  const push = (event: JournalEventInput) => { budget?.event(event); events.push(event); };
  const created: ScopedNode[] = [];
  const deleted: ScopedNode[] = [];
  const changed: { before: ScopedNode; after: ScopedNode }[] = [];

  for (const [key, node] of after.entries) {
    const prior = before.entries.get(key);
    if (prior === undefined) {
      if (before.coverage ? scanPresence(key, before.entries, before.coverage) === "absent" : before.errors.length === 0) created.push(node);
      else push({ type: "observation", path: node.path, reason: "baseline-unknown", after: observedNode(node) });
    }
    else if (replaced(prior, node)) {
      deleted.push(prior);
      created.push(node);
    } else if (changedNode(prior, node)) changed.push({ before: prior, after: node });
  }
  for (const [key, node] of before.entries)
    if (!after.entries.has(key) && (after.coverage ? scanPresence(key, after.entries, after.coverage) === "absent" : after.errors.length === 0)) deleted.push(node);

  for (const node of sortNodes(deleted)) push(removeEvent(node));
  for (const node of sortNodes(created)) push(createEvent(node));
  for (const pair of changed.sort((a, b) => comparePaths(a.after.path, b.after.path))) {
    if (pair.after.kind === "file") {
      if (pair.before.mode !== pair.after.mode) push(modeEvent(pair.before, pair.after));
      if (fileContentChanged(pair.before, pair.after)) push(writeEvent(pair.before, pair.after));
    } else if (pair.after.kind === "directory" && pair.before.mode !== pair.after.mode) {
      push(modeEvent(pair.before, pair.after));
    }
  }
  return events;
}

/** A node counts as replaced when its kind changed or a symlink now points somewhere else. */
function replaced(prior: ScopedNode, node: ScopedNode): boolean {
  if (prior.kind !== node.kind) return true;
  return node.kind === "symlink" && prior.linkTarget !== node.linkTarget;
}

/** A same-kind node counts as changed when its content stamp or permission bits moved. */
function changedNode(prior: ScopedNode, node: ScopedNode): boolean {
  if (node.kind === "file") return prior.mode !== node.mode || fileContentChanged(prior, node);
  if (node.kind === "directory") return prior.mode !== node.mode;
  return false; // a symlink that still points where it did is unchanged
}

function fileContentChanged(before: ScopedNode, after: ScopedNode): boolean {
  return fileStampChanged(before, after) || (before.hash !== undefined && after.hash !== undefined && before.hash !== after.hash);
}

function observedNode(node: ScopedNode) {
  if (node.kind === "file") return fileMetadata(node);
  if (node.kind === "symlink") return { kind: "symlink" as const, target: linkTargetOf(node), mode: node.mode };
  return { kind: "directory" as const, mode: node.mode };
}

function createEvent(node: ScopedNode): JournalEventInput {
  switch (node.kind) {
    case "file":
      return { type: "create", path: node.path, after: fileMetadata(node) };
    case "directory":
      return { type: "mkdir", path: node.path, after: { kind: "directory", mode: node.mode } };
    case "symlink":
      return {
        type: "symlink",
        path: node.path,
        target: linkTargetOf(node),
        after: { kind: "symlink", target: linkTargetOf(node), mode: node.mode },
      };
  }
}

function removeEvent(node: ScopedNode): JournalEventInput {
  switch (node.kind) {
    case "file":
      return { type: "unlink", path: node.path, before: fileMetadata(node) };
    case "directory":
      return { type: "rmdir", path: node.path, before: { kind: "directory", mode: node.mode } };
    case "symlink":
      return { type: "unlink", path: node.path, before: { kind: "symlink", target: linkTargetOf(node), mode: node.mode } };
  }
}

function writeEvent(before: ScopedNode, after: ScopedNode): JournalEventInput {
  return { type: "write", path: after.path, before: fileMetadata(before), after: fileMetadata(after) };
}

function modeEvent(before: ScopedNode, after: ScopedNode): JournalEventInput {
  return { type: "chmod", path: after.path, before: { mode: before.mode }, after: { mode: after.mode } };
}

/** File metadata; `hash` is included only when the file was hashed (created or stamp-changed). */
function fileMetadata(node: ScopedNode): FileMetadata {
  const metadata: FileMetadata = { kind: "file", size: node.size, mode: node.mode, mtimeMs: node.mtimeMs };
  if (node.hash !== undefined) metadata.hash = node.hash;
  return metadata;
}

function linkTargetOf(node: ScopedNode): AbsolutePath {
  return node.linkTarget ?? "";
}

function sortNodes(nodes: ScopedNode[]): ScopedNode[] {
  return [...nodes].sort((a, b) => comparePaths(a.path, b.path));
}

function comparePaths(a: AbsolutePath, b: AbsolutePath): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
