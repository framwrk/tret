import { existsSync, lstatSync, rmSync } from "node:fs";
import type { AbsolutePath } from "../types";

/** Why a recorded path was kept instead of deleted. */
export type KeptReason = "guarded" | "failed";

export type Removal = {
  removed: AbsolutePath[];
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
 * Deletes the recorded added paths, deepest first. Directories that look shared or too broad are guarded,
 * and anything that fails to delete is kept. With `dryRun` nothing touches the disk.
 */
export function removeAdded(paths: AbsolutePath[], dryRun: boolean): Removal {
  const removed: AbsolutePath[] = [];
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
      kept.push({ path, reason: "guarded" });
      continue;
    }

    if (dryRun) {
      removed.push(path);
      continue;
    }

    try {
      rmSync(path, { recursive: true });
      removed.push(path);
    } catch {
      kept.push({ path, reason: "failed" });
    }
  }

  return { removed, kept };
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
