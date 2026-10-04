import type { AbsolutePath, Snapshot } from "../types";
import { EXCLUDED_DIR_NAMES, EXCLUDED_PATHS, SCAN_OPTIONS, SNAPSHOT_ROOTS } from "../constants";
import { Glob } from "bun";

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
  let names: string[];
  let subdirs: Set<string>;
  try {
    names = [...new Glob("*").scanSync({ ...SCAN_OPTIONS, cwd: dir })];
    subdirs = new Set(new Glob("*/").scanSync({ ...SCAN_OPTIONS, cwd: dir }));
  } catch {
    return;
  }

  for (const name of names) {
    const path = `${dir}/${name}`;
    const isSubdir = subdirs.has(name);
    if (excluded.has(path) || (isSubdir && EXCLUDED_DIR_NAMES.has(name))) continue;
    entries.set(path, Bun.file(path).lastModified);
    if (isSubdir) snapshotDir(path, entries, excluded);
  }
}
