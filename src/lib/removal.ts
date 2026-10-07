import { dirname, join } from "node:path";
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import type { AbsolutePath } from "../types";

/** Why a recorded path was kept instead of deleted. */
export type KeptReason = "guarded" | "failed";

export type Removal = {
  removed: AbsolutePath[];
  /** Tool-named children pruned out of a protected directory. */
  pruned: AbsolutePath[];
  kept: { path: AbsolutePath; reason: KeptReason }[];
};

// Directories many programs share; uninstall refuses to delete them. Adapted from bashka's SHARED_IN_HOME/SHARED_ABSOLUTE for macOS.
const SHARED_IN_HOME = [
  ".config",
  ".cache",
  ".local",
  ".local/bin",
  ".local/lib",
  ".local/share",
  ".local/state",
  ".ssh",
  ".zshrc.d",
  "Applications",
  "Library",
  "bin",
  "go",
  "go/bin",
];

const SHARED_ABSOLUTE = [
  "/",
  "/Applications",
  "/Library",
  "/bin",
  "/etc",
  "/opt",
  "/opt/homebrew",
  "/opt/homebrew/bin",
  "/sbin",
  "/tmp",
  "/usr",
  "/usr/bin",
  "/usr/lib",
  "/usr/local",
  "/usr/local/bin",
  "/usr/local/lib",
  "/usr/local/share",
  "/usr/share",
  "/var",
];

/**
 * Deletes the recorded added paths, deepest first. Directories that look shared or too broad are
 * guarded: the tool's own entries inside them are pruned (matched by the tool name), and the
 * directory itself is removed only if that leaves it empty. Anything that fails to delete is kept.
 * With `dryRun` nothing touches the disk.
 */
export function removeAdded(paths: AbsolutePath[], name: string, dryRun: boolean): Removal {
  const removed: AbsolutePath[] = [];
  const pruned: AbsolutePath[] = [];
  const kept: Removal["kept"] = [];

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  // Deepest first, so nested entries are gone before the folder holding them.
  const ordered = paths.slice().sort((a, b) => b.split("/").length - a.split("/").length);

  for (const path of ordered) {
    if (!existsSync(path)) {
      removed.push(path);
      continue;
    }

    // Only directories get the guards: deleting a file from a shared bin folder is exactly what uninstall is for.
    if (lstatSync(path).isDirectory() && (isGuarded(path, home) || isShallow(path))) {
      removeGuarded(path, name, dryRun, removed, pruned, kept);
      continue;
    }

    if (dryRun) {
      removed.push(path);
      continue;
    }

    try {
      rmSync(path, { recursive: true });
      removed.push(path);
      pruneEmptyAncestors(path);
    } catch {
      kept.push({ path, reason: "failed" });
    }
  }

  return { removed, pruned, kept };
}

/**
 * Cleans a guarded directory: the tool's own entries anywhere inside it are pruned (matched by
 * name), now-empty folders below it go too, and the directory itself is removed only if nothing
 * else is left. A guard-refused dir that keeps other programs' files stays recorded.
 */
function removeGuarded(
  path: AbsolutePath,
  name: string,
  dryRun: boolean,
  removed: AbsolutePath[],
  pruned: AbsolutePath[],
  kept: Removal["kept"],
): void {
  const matches = (entry: string): boolean => entry.toLowerCase() === name.toLowerCase();

  if (!pruneToolEntries(path, matches, dryRun, pruned, kept)) {
    return;
  }

  if (dryRun) {
    if (emptiesAfterPrune(path, matches)) {
      removed.push(path);
    } else {
      kept.push({ path, reason: "guarded" });
    }
    return;
  }

  removeEmptyDirs(path);

  if (!existsSync(path)) {
    removed.push(path);
    pruneEmptyAncestors(path);
  } else {
    kept.push({ path, reason: "guarded" });
  }
}

/** Deletes entries named like the tool at any depth; false means a delete failed and the run should stop. */
function pruneToolEntries(
  dir: AbsolutePath,
  matches: (entry: string) => boolean,
  dryRun: boolean,
  pruned: AbsolutePath[],
  kept: Removal["kept"],
): boolean {
  for (const entry of readdirSync(dir).sort()) {
    const child = join(dir, entry);

    if (matches(entry)) {
      if (dryRun) {
        pruned.push(child);
        continue;
      }
      try {
        rmSync(child, { recursive: true });
        pruned.push(child);
      } catch {
        kept.push({ path: child, reason: "failed" });
        return false;
      }
      continue;
    }

    if (lstatSync(child).isDirectory() && !pruneToolEntries(child, matches, dryRun, pruned, kept)) {
      return false;
    }
  }

  return true;
}

/** True when everything in the tree is either tool-named or an empty folder once they are pruned. */
function emptiesAfterPrune(dir: AbsolutePath, matches: (entry: string) => boolean): boolean {
  for (const entry of readdirSync(dir)) {
    if (matches(entry)) {
      continue;
    }

    const child = join(dir, entry);
    if (!lstatSync(child).isDirectory() || !emptiesAfterPrune(child, matches)) {
      return false;
    }
  }

  return true;
}

/** Removes now-empty folders bottom up, the starting dir last; a dir with contents simply fails to rmdir. */
function removeEmptyDirs(dir: AbsolutePath): void {
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    if (lstatSync(child).isDirectory()) {
      removeEmptyDirs(child);
    }
  }

  try {
    rmdirSync(dir);
  } catch {
    // Still holds other programs' entries; that is what the guard is for.
  }
}

/** True for a folder many programs share. An install never records a new one whole; what it put inside is recorded instead. */
export function isSharedFolder(path: AbsolutePath): boolean {
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");
  return isGuarded(path, home);
}

/**
 * Removes now-empty parent folders of a deleted path, up to `$HOME` and only under it, so an install's
 * empty leftovers (a fresh `~/.local/share`) do not survive uninstall. Each `rmdir` fails harmlessly on
 * a folder that still holds anything.
 */
function pruneEmptyAncestors(path: AbsolutePath): void {
  const home = Bun.env.HOME;
  if (!home || !path.startsWith(`${home}/`)) {
    return;
  }

  let parent = dirname(path);
  while (parent.startsWith(`${home}/`)) {
    try {
      rmdirSync(parent);
    } catch {
      return;
    }
    parent = dirname(parent);
  }
}

function isGuarded(path: AbsolutePath, home: AbsolutePath): boolean {
  if (SHARED_ABSOLUTE.includes(path) || path === home) {
    return true;
  }

  const relative = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : undefined;
  return relative !== undefined && SHARED_IN_HOME.includes(relative);
}

function isShallow(path: AbsolutePath): boolean {
  return path.split("/").filter(Boolean).length < 3;
}
