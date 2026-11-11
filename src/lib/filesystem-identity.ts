import { dirname, isAbsolute } from "node:path";
import { lstatSync, readlinkSync, statSync } from "node:fs";

/** One signature per path component; null means the component was missing. */
export type FilesystemIdentity = Record<string, string | null>;

/**
 * Bind a path to its object and ancestors, including stable platform symlinks such as /var.
 * This detects substitutions between capture/planning/apply; it does not close the remaining
 * path-based syscall race. Missing components are explicit; unreadable ancestors fail closed.
 */
export function filesystemIdentity(path: string): FilesystemIdentity | undefined {
  if (!isAbsolute(path)) return undefined;
  const components: FilesystemIdentity = {};
  let current = path;
  try {
    for (;;) {
      let node;
      try {
        node = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        components[current] = null;
      }
      if (node !== undefined) {
        const target = node.isSymbolicLink() ? readlinkSync(current) : undefined;
        // A dangling ancestor cannot safely be traversed. Keep its resolution failure distinct
        // from a missing directory, rather than letting mkdir during restore follow it.
        const resolved = node.isSymbolicLink() && current !== path ? statSync(current) : node;
        components[current] = JSON.stringify([node.dev, node.ino, node.mode & 0o170000, target, resolved.dev, resolved.ino]);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return components;
  } catch {
    return undefined;
  }
}

/** Compare exactly, permitting only missing ancestors created by earlier successful restores. */
export function sameFilesystemIdentity(
  expected: FilesystemIdentity | undefined,
  actual: FilesystemIdentity | undefined,
  createdParents: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (expected === undefined || actual === undefined) return expected === actual;
  return (
    Object.keys(expected).length === Object.keys(actual).length &&
    Object.entries(expected).every(
      ([path, identity]) =>
        identity === actual[path] ||
        (identity === null && createdParents.has(path) && createdParents.get(path) === actual[path]),
    )
  );
}

export function rememberCreatedParents(
  path: string,
  before: FilesystemIdentity | undefined,
  createdParents: Map<string, string>,
): void {
  if (before === undefined) return;
  const after = filesystemIdentity(path);
  for (const [parent, identity] of Object.entries(before)) {
    if (parent === path || identity !== null) continue;
    try {
      if (!lstatSync(parent).isDirectory()) continue;
    } catch {
      // A successful write is not undone by a bookkeeping failure. No exemption is granted.
      continue;
    }
    const created = after?.[parent];
    if (typeof created === "string") createdParents.set(parent, created);
  }
}
