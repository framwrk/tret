import type { AbsolutePath, Diff, Snapshot } from "../types";
import { isSharedFolder } from "./removal";
import { scanPresence } from "./capture/scan-coverage";

/**
 * Compares two snapshots into sorted added, edited, and deleted paths. Files inside an added folder are not
 * recorded, and a new shared folder (such as `~/.local/share`) is not recorded whole: what was added inside it is.
 */
export function diff(before: Snapshot, after: Snapshot): Diff {
  const added: AbsolutePath[] = [];
  const edited: AbsolutePath[] = [];
  const deleted: AbsolutePath[] = [];

  for (const [path, stamp] of before) {
    const now = after.get(path);
    if (now === undefined) {
      if (after.coverage ? scanPresence(path, after, after.coverage) === "absent" : !after.errors?.length) deleted.push(path);
    } else if (
      now.mode !== stamp.mode ||
      now.kind !== stamp.kind ||
      (!now.isDir && (now.mtimeMs !== stamp.mtimeMs || now.size !== stamp.size || now.inode !== stamp.inode))
    ) {
      edited.push(path);
    }
  }

  for (const path of [...after.keys()].sort()) {
    if (before.has(path)) continue;
    if (before.coverage ? scanPresence(path, before, before.coverage) !== "absent" : before.errors?.length) {
      if (!after.get(path)?.isDir) edited.push(path);
      continue;
    }
    if (added.length > 0 && path.startsWith(`${added.at(-1)}/`)) continue;
    if (after.get(path)?.isDir && isSharedFolder(path)) continue;
    added.push(path);
  }

  return { added, edited: edited.sort(), deleted: deleted.sort() };
}
