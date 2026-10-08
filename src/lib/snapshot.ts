import type { AbsolutePath, FileStamp, Snapshot } from "../types";
import { EXCLUDED_DIR_NAMES, EXCLUDED_DIR_NAME_PATTERN, EXCLUDED_PATHS, SNAPSHOT_ROOTS } from "../constants";
import { lstatSync } from "node:fs";
import { scanDir } from "./scan";

export function snapshot(): Snapshot {
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  const entries: Snapshot = new Map();
  const excluded = new Set(EXCLUDED_PATHS.map((path) => `${home}/${path}`));
  snapshotDir(home, entries, excluded);
  for (const root of SNAPSHOT_ROOTS) snapshotDir(root, entries);
  return entries;
}

function snapshotDir(dir: AbsolutePath, entries: Snapshot, excluded: Set<string> = new Set()): void {
  const scan = scanDir(dir);
  if (!scan) return;

  for (const name of scan.names) {
    const path = `${dir}/${name}`;
    const isSubdir = scan.subdirs.has(name);
    if (excluded.has(path) || (isSubdir && (EXCLUDED_DIR_NAMES.has(name) || EXCLUDED_DIR_NAME_PATTERN.test(name)))) continue;
    const stamp = stampEntry(path);
    if (!stamp) continue;
    entries.set(path, stamp);
    if (isSubdir) snapshotDir(path, entries, excluded);
  }
}

/** Stamps one entry with its lstat fields; returns undefined when the entry cannot be read. */
function stampEntry(path: AbsolutePath): FileStamp | undefined {
  try {
    const stat = lstatSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size, inode: stat.ino, isDir: stat.isDirectory() };
  } catch {
    return undefined;
  }
}
