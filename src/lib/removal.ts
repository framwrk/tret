import type { AbsolutePath, RecordV3 } from "../types";
import { PRIVATE_FILE_MODE, writeFileAtomic } from "./atomic";
import type { UninstallAction, UninstallPlan, UninstallVerification } from "./uninstall-planner";
import { dirname, join } from "node:path";
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { inspectPath, listChildren } from "./uninstall-planner";
import type { Storage } from "./storage";

// Verified uninstall (phase 7). The planner decides what is safe to do; this module carries it out.
// Every operation is re-checked immediately before it runs and is deliberately non-recursive, so a
// plan can never turn into an unverified recursive delete of a shared tree.

/** Filesystem operations the applier needs; injectable so tests never touch the real disk. */
export type RemovalFileSystem = {
  /** Unlinks a file or symlink; never recursive, so a directory throws instead of vanishing. */
  removeFile(path: AbsolutePath): void;
  /** Removes an empty directory; a non-empty directory throws rather than being recursed. */
  removeDir(path: AbsolutePath): void;
  /** Atomically writes restored bytes, creating parent directories as needed. */
  writeFile(path: AbsolutePath, bytes: Uint8Array): void;
};

/** The real filesystem, used when an applier caller does not inject one. */
export const nodeRemovalFileSystem: RemovalFileSystem = {
  removeFile(path) {
    rmSync(path);
  },
  removeDir(path) {
    rmdirSync(path);
  },
  writeFile(path, bytes) {
    writeFileAtomic(path, bytes, PRIVATE_FILE_MODE);
  },
};

/** What happened to one planned path. */
export type ApplianceOutcome =
  | { path: AbsolutePath; outcome: "removed" }
  | { path: AbsolutePath; outcome: "restored" }
  | { path: AbsolutePath; outcome: "skipped"; reason: string }
  | { path: AbsolutePath; outcome: "conflict"; reason: string }
  | { path: AbsolutePath; outcome: "failed"; reason: string };

/** The result of applying a plan: what changed and what still blocks a clean uninstall. */
export type ApplyUninstallResult = {
  outcomes: ApplianceOutcome[];
  removed: AbsolutePath[];
  restored: AbsolutePath[];
  skipped: AbsolutePath[];
  conflicts: AbsolutePath[];
  failed: AbsolutePath[];
  /** True when conflicts or failures mean the record must be retained for a safe retry. */
  incomplete: boolean;
};

/** Inputs the applier needs; a real caller supplies `storage` so before-images can be read. */
export type ApplyUninstallOptions = {
  /** Reads before-image blobs for restore actions. */
  storage: Pick<Storage, "getBlob">;
  /** Re-inspects a path immediately before acting; defaults to the real filesystem. */
  inspect?: (path: AbsolutePath) => UninstallVerification;
  /** Lists a directory to re-confirm it is still empty; defaults to the real filesystem. */
  list?: (path: AbsolutePath) => AbsolutePath[];
  /** Filesystem primitives; defaults to the real filesystem. */
  fs?: RemovalFileSystem;
};

/**
 * Applies a plan one action at a time, verifying against current state as it goes. A removal whose
 * path was changed, replaced by a directory, or refilled between planning and applying is reported
 * as a conflict instead of being forced. A restore never overwrites an existing path. Anything that
 * throws is recorded as `failed` and left in place, so a retry sees only the survivors.
 */
export async function applyUninstallPlan(plan: UninstallPlan, options: ApplyUninstallOptions): Promise<ApplyUninstallResult> {
  const inspect = options.inspect ?? inspectPath;
  const list = options.list ?? listChildren;
  const fs = options.fs ?? nodeRemovalFileSystem;

  const outcomes: ApplianceOutcome[] = [];
  const removed: AbsolutePath[] = [];
  const restored: AbsolutePath[] = [];
  const skipped: AbsolutePath[] = [];
  const conflicts: AbsolutePath[] = [];
  const failed: AbsolutePath[] = [];

  for (const action of plan.actions) {
    switch (action.action) {
      case "skip":
        outcomes.push({ path: action.path, outcome: "skipped", reason: action.reason });
        skipped.push(action.path);
        break;

      case "conflict":
        outcomes.push({ path: action.path, outcome: "conflict", reason: action.reason });
        conflicts.push(action.path);
        break;

      case "remove":
        applyRemove(action, inspect, list, fs, outcomes, removed, conflicts, failed);
        break;

      case "restore":
        await applyRestore(action, options.storage, inspect, fs, outcomes, restored, conflicts, failed);
        break;
    }
  }

  return { outcomes, removed, restored, skipped, conflicts, failed, incomplete: conflicts.length > 0 || failed.length > 0 };
}

/** Removes one path if it still looks safe, using only non-recursive primitives. */
function applyRemove(
  action: Extract<UninstallAction, { action: "remove" }>,
  inspect: (path: AbsolutePath) => UninstallVerification,
  list: (path: AbsolutePath) => AbsolutePath[],
  fs: RemovalFileSystem,
  outcomes: ApplianceOutcome[],
  removed: AbsolutePath[],
  conflicts: AbsolutePath[],
  failed: AbsolutePath[],
): void {
  const verification = inspect(action.path);
  if (!verification.exists) {
    outcomes.push({ path: action.path, outcome: "skipped", reason: "absent" });
    return;
  }

  // Re-confirm an owned directory is still empty; between planning and applying a user file may
  // have appeared, and the applier must never recurse into a tree it did not verify.
  if (verification.kind === "directory") {
    if (list(action.path).length > 0) {
      outcomes.push({ path: action.path, outcome: "conflict", reason: "not-empty" });
      conflicts.push(action.path);
      return;
    }
    try {
      fs.removeDir(action.path);
    } catch (error) {
      outcomes.push({ path: action.path, outcome: "failed", reason: message(error) });
      failed.push(action.path);
      return;
    }
  } else {
    try {
      fs.removeFile(action.path);
    } catch (error) {
      outcomes.push({ path: action.path, outcome: "failed", reason: message(error) });
      failed.push(action.path);
      return;
    }
  }

  outcomes.push({ path: action.path, outcome: "removed" });
  removed.push(action.path);
}

/** Restores one before-image, re-verifying the current state the plan was built from. */
async function applyRestore(
  action: Extract<UninstallAction, { action: "restore" }>,
  storage: Pick<Storage, "getBlob">,
  inspect: (path: AbsolutePath) => UninstallVerification,
  fs: RemovalFileSystem,
  outcomes: ApplianceOutcome[],
  restored: AbsolutePath[],
  conflicts: AbsolutePath[],
  failed: AbsolutePath[],
): Promise<void> {
  const verification = inspect(action.path);

  // A mutation restore overwrites the installed bytes; a deletion restore recreates an absent path.
  // Either way, a state change since planning is preserved, not overwritten.
  if (action.expect === "installed") {
    if (!verification.exists) {
      outcomes.push({ path: action.path, outcome: "conflict", reason: "diverged" });
      conflicts.push(action.path);
      return;
    }
    if (action.installedHash !== undefined && verification.hash !== action.installedHash) {
      outcomes.push({ path: action.path, outcome: "conflict", reason: "diverged" });
      conflicts.push(action.path);
      return;
    }
  } else if (verification.exists) {
    outcomes.push({ path: action.path, outcome: "conflict", reason: "diverged" });
    conflicts.push(action.path);
    return;
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = await storage.getBlob(action.beforeBlob);
  } catch (error) {
    outcomes.push({ path: action.path, outcome: "failed", reason: message(error) });
    failed.push(action.path);
    return;
  }

  if (bytes === undefined) {
    outcomes.push({ path: action.path, outcome: "conflict", reason: "missing-blob" });
    conflicts.push(action.path);
    return;
  }

  try {
    fs.writeFile(action.path, bytes);
  } catch (error) {
    outcomes.push({ path: action.path, outcome: "failed", reason: message(error) });
    failed.push(action.path);
    return;
  }

  outcomes.push({ path: action.path, outcome: "restored" });
  restored.push(action.path);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drops everything a run actually removed or restored, plus shell configs it cleaned, leaving only
 * the entries a retry still needs. Keeping the survivors (rather than the full record) means a
 * restored or removed path is never re-verified on the next run and reported as a false conflict.
 */
export function reduceRecordForRetry(
  record: RecordV3,
  result: ApplyUninstallResult,
  cleanedShell: Iterable<AbsolutePath> = [],
): RecordV3 {
  const removed = new Set(result.removed);
  const restored = new Set(result.restored);
  const cleaned = new Set(cleanedShell);
  return {
    ...record,
    owned: record.owned.filter((entry) => !removed.has(entry.path)),
    mutated: record.mutated.filter((entry) => !restored.has(entry.path) && !cleaned.has(entry.path)),
    deleted: record.deleted.filter((entry) => !restored.has(entry.path)),
  };
}

// ---------------------------------------------------------------------------------------------
// Legacy pre-rewrite removal, retained for the v2 `install` reinstall path until phase 5/9 move
// that command onto v3 records. The rewritten `uninstall` command does not call any of this; see
// `applyUninstallPlan` above for the evidence-based path.

/** Why a recorded path was kept instead of deleted. */
export type KeptReason = "guarded" | "failed";

export type Removal = {
  removed: AbsolutePath[];
  /** Tool-named children pruned out of a protected directory. */
  pruned: AbsolutePath[];
  kept: { path: AbsolutePath; reason: KeptReason }[];
};

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
