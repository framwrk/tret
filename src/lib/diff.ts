import type { AbsolutePath, Diff, Snapshot } from "../types";

/** Compares two snapshots into sorted added, edited, and deleted paths. Files inside an added folder are not recorded. */
export function diff(before: Snapshot, after: Snapshot): Diff {
  const added: AbsolutePath[] = [];
  const edited: AbsolutePath[] = [];
  const deleted: AbsolutePath[] = [];

  for (const [path, stamp] of before) {
    const now = after.get(path);
    if (now === undefined) deleted.push(path);
    else if (!now.isDir && (now.mtimeMs !== stamp.mtimeMs || now.size !== stamp.size || now.inode !== stamp.inode)) {
      edited.push(path);
    }
  }

  for (const path of [...after.keys()].sort()) {
    if (before.has(path)) continue;
    if (added.length > 0 && path.startsWith(`${added.at(-1)}/`)) continue;
    added.push(path);
  }

  return { added, edited: edited.sort(), deleted: deleted.sort() };
}

/** Unions two diffs taken against the same before snapshot; a path deleted after being edited counts as deleted. */
export function mergeDiff(first: Diff, second: Diff): Diff {
  const union = (a: AbsolutePath[], b: AbsolutePath[]): AbsolutePath[] => [...new Set([...a, ...b])].sort();
  const deleted = union(first.deleted, second.deleted);
  return {
    added: union(first.added, second.added),
    edited: union(first.edited, second.edited).filter((path) => !deleted.includes(path)),
    deleted,
  };
}
