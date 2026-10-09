import type { FileMetadata, JournalEventInput } from "../events";
import { type Stats, lstatSync, readdirSync, readlinkSync } from "node:fs";
import type { AbsolutePath } from "../../../types";

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
};

/** A bounded snapshot of one or more roots, plus any roots that could not be read. */
export type ScopedSnapshot = {
  /** Case-correct key to node (D10). */
  entries: Map<string, ScopedNode>;
  /** Roots that exist but could not be scanned; coverage is incomplete when non-empty. */
  errors: string[];
};

export type ScopedScanOptions = {
  /** Whether path comparison is case-sensitive (D10). */
  caseSensitive: boolean;
};

/** The comparison key for a path; mirrors journal normalization so both agree on identity (D10). */
export function scopedPathKey(path: AbsolutePath, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase();
}

/**
 * Walks every root and records each node's stamp without following symlinks. A root that does not
 * exist is not an error (an installer may create it); a root that exists but cannot be read is. The
 * roots are the only bound: there is no exclusion list here, by design (plan section 2).
 */
export function scanScopedRoots(roots: Iterable<AbsolutePath>, options: ScopedScanOptions): ScopedSnapshot {
  const entries = new Map<string, ScopedNode>();
  const errors: string[] = [];
  for (const root of roots) scanNode(root, entries, errors, options, true);
  return { entries, errors };
}

function scanNode(
  path: AbsolutePath,
  entries: Map<string, ScopedNode>,
  errors: string[],
  options: ScopedScanOptions,
  isRoot: boolean,
): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    // A missing root is expected; the installer may create it. Only a real read failure is coverage loss.
    if (isRoot && (error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${path}: ${describe(error)}`);
    return;
  }

  const node = toScopedNode(path, stat);
  if (!node) return; // sockets, fifos, and other non-regular nodes are not tracked
  entries.set(scopedPathKey(path, options.caseSensitive), node);
  if (node.kind !== "directory") return;

  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch (error) {
    errors.push(`${path}: ${describe(error)}`);
    return;
  }
  for (const name of names) scanNode(`${path}/${name}`, entries, errors, options, false);
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
 * Files whose content must be hashed at stop: created files and files whose stamps changed. The
 * fallback deliberately does not hash at start, so a plain edit keeps no before-hash and is recorded
 * as a non-restorable mutation (see `docs/rewrite/macos-capture.md`).
 */
export function filesToHash(before: ScopedSnapshot, after: ScopedSnapshot): AbsolutePath[] {
  const paths: AbsolutePath[] = [];
  for (const [key, node] of after.entries) {
    if (node.kind !== "file") continue;
    const prior = before.entries.get(key);
    if (prior === undefined || prior.kind !== "file" || fileStampChanged(prior, node)) paths.push(node.path);
  }
  return paths.sort();
}

/** sha256 of a file's content, or undefined when it cannot be read. */
export async function hashFile(path: AbsolutePath): Promise<string | undefined> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
    return hasher.digest("hex");
  } catch {
    return undefined;
  }
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
export function diffScopedSnapshots(before: ScopedSnapshot, after: ScopedSnapshot): JournalEventInput[] {
  const events: JournalEventInput[] = [];
  const created: ScopedNode[] = [];
  const deleted: ScopedNode[] = [];
  const changed: { before: ScopedNode; after: ScopedNode }[] = [];

  for (const [key, node] of after.entries) {
    const prior = before.entries.get(key);
    if (prior === undefined) created.push(node);
    else if (replaced(prior, node)) {
      deleted.push(prior);
      created.push(node);
    } else if (changedNode(prior, node)) changed.push({ before: prior, after: node });
  }
  for (const [key, node] of before.entries) if (!after.entries.has(key)) deleted.push(node);

  for (const node of sortNodes(deleted)) events.push(removeEvent(node));
  for (const node of sortNodes(created)) events.push(createEvent(node));
  for (const pair of changed.sort((a, b) => comparePaths(a.after.path, b.after.path))) {
    if (pair.after.kind === "file") {
      if (pair.before.mode !== pair.after.mode) events.push(modeEvent(pair.before, pair.after));
      if (fileStampChanged(pair.before, pair.after)) events.push(writeEvent(pair.before, pair.after));
    } else if (pair.after.kind === "directory" && pair.before.mode !== pair.after.mode) {
      events.push(modeEvent(pair.before, pair.after));
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
  if (node.kind === "file") return prior.mode !== node.mode || fileStampChanged(prior, node);
  if (node.kind === "directory") return prior.mode !== node.mode;
  return false; // a symlink that still points where it did is unchanged
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
