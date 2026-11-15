import type { AbsolutePath, FileStamp, Snapshot } from "../types";
import { CaptureBudget, CaptureBudgetError } from "./capture/budget";
import { EXCLUDED_DIR_NAMES, EXCLUDED_DIR_NAME_PATTERN, EXCLUDED_PATHS } from "../constants";
import { lstatSync, opendirSync } from "node:fs";
import { currentPlatform } from "./platform";
import { newScanCoverage } from "./capture/scan-coverage";
import { privateStateFilter } from "./capture/self-state";

export function snapshot(roots?: AbsolutePath[], budget = new CaptureBudget()): Snapshot {
  budget.ensurePhase();
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  const entries: Snapshot = new Map();
  entries.errors = [];
  entries.coverage = newScanCoverage();
  const excluded = new Set(EXCLUDED_PATHS.map((path) => `${home}/${path}`));
  const privateState = privateStateFilter(home);
  for (const root of [...new Set(roots ?? [home, ...currentPlatform().scopeRoots])].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  )) {
    budget.check();
    if (privateState(root) || excluded.has(root)) {
      budget.inspect(root);
      entries.coverage.unknownPaths.add(root);
      continue;
    }
    if (entries.has(root)) continue;
    budget.inspect(root);
    const stamp = stampEntry(root, (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.coverage!.absentRoots.add(root);
      else {
        entries.coverage!.unknownPaths.add(root);
        if (entries.errors!.length < 32) entries.errors!.push(`${root}: ${String(error)}`);
      }
    });
    if (!stamp) continue;
    if (stamp.kind === "unknown") {
      entries.coverage.unknownPaths.add(root);
      if (entries.errors!.length < 32) entries.errors!.push(`${root}: unsupported node type`);
    }
    if (stamp.isDir) snapshotDir(root, entries, excluded, privateState, budget);
    else entries.set(root, stamp);
  }
  budget.check();
  return entries;
}

function snapshotDir(
  dir: AbsolutePath,
  entries: Snapshot,
  excluded: Set<string>,
  privateState: (path: string) => boolean,
  budget: CaptureBudget,
  depth = 0,
): void {
  budget.depth(depth);
  let directory;
  try {
    directory = opendirSync(dir, { bufferSize: 32 });
    for (;;) {
      budget.check();
      const item = directory.readSync();
      if (!item) break;
      const name = item.name;
      const path = `${dir}/${name}`;
      const isSubdir = item.isDirectory();
      if (entries.has(path)) continue;
      budget.inspect(path);
      if (
        privateState(path) ||
        excluded.has(path) ||
        (isSubdir && (EXCLUDED_DIR_NAMES.has(name) || EXCLUDED_DIR_NAME_PATTERN.test(name)))
      ) {
        entries.coverage!.unknownPaths.add(path);
        continue;
      }
      const stamp = stampEntry(path);
      if (!stamp) {
        entries.coverage!.unknownPaths.add(path);
        if (entries.errors!.length < 32) entries.errors!.push(`${path}: state changed or unreadable during scanning`);
        continue;
      }
      if (stamp.kind === "unknown") {
        entries.coverage!.unknownPaths.add(path);
        if (entries.errors!.length < 32) entries.errors!.push(`${path}: unsupported node type`);
      }
      entries.set(path, stamp);
      if (isSubdir) snapshotDir(path, entries, excluded, privateState, budget, depth + 1);
    }
    entries.coverage!.completeDirectories.add(dir);
  } catch (error) {
    if (error instanceof CaptureBudgetError) throw error;
    entries.coverage!.unknownPaths.add(dir);
    if (entries.errors!.length < 32) entries.errors!.push(`${dir}: ${String(error)}`);
  } finally {
    directory?.closeSync();
  }
}

/** Stamps one entry with its lstat fields; returns undefined when the entry cannot be read. */
function stampEntry(path: AbsolutePath, onError?: (error: unknown) => void): FileStamp | undefined {
  try {
    const stat = lstatSync(path);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      inode: stat.ino,
      isDir: stat.isDirectory(),
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "unknown",
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}
