import type { AbsolutePath, OwnedEntry, OwnedKind, RecordV3 } from "../types";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { BlobId } from "./storage";
import { join } from "node:path";

/** Current on-disk state of one path, used to verify before removing or restoring it. */
export type UninstallVerification = {
  exists: boolean;
  kind?: OwnedKind;
  /** sha256 of the current content, when present and readable. */
  hash?: string;
  /** Symlink target read with `readlink`, never followed; only set when `kind` is "symlink". */
  linkTarget?: AbsolutePath;
  /** Numeric owner id, when the platform exposes one; drives sudo-aware planning (D8). */
  uid?: number;
};

/** Why a path is skipped without changing it. */
export type UninstallSkipReason = "absent" | "not-owned" | "already-empty";

/** Why a path needs the user's attention instead of being changed. */
export type UninstallConflictReason =
  | "modified"
  | "shared-owner"
  | "diverged"
  | "unreadable"
  /** A fingerprinted path recorded before the rewrite (`kind: "unknown"`) or without a hash; never removed (D4). */
  | "unverified"
  /** An owned directory that still holds entries this record does not own; never recursively deleted. */
  | "not-empty";

/**
 * Why a recorded change is detect-only: the install altered a pre-existing path but captured no
 * before-image, so uninstall can report the change but never restore or reverse it (D2). These are
 * informational and never block a clean uninstall.
 */
export type UninstallDetectedKind = "mutated" | "deleted";

/**
 * One planned uninstall step: `conflict` is actionable (it blocks completion until resolved or
 * forced), while `detected` is informational (a non-restorable change that is reported but never
 * blocks). `remove`, `restore`, and `skip` round out the shapes the planner emits.
 */
export type UninstallAction =
  | { action: "remove"; path: AbsolutePath; kind: OwnedKind }
  | {
      action: "restore";
      path: AbsolutePath;
      kind: OwnedKind;
      beforeBlob: BlobId;
      /** Whether the applier expects the path absent (a deletion) or holding the installed bytes (a mutation). */
      expect?: "absent" | "installed";
      /** For `expect: "installed"`, the hash the path must still match before it is overwritten. */
      installedHash?: string;
    }
  | { action: "skip"; path: AbsolutePath; reason: UninstallSkipReason }
  | { action: "detected"; path: AbsolutePath; kind: UninstallDetectedKind }
  | { action: "conflict"; path: AbsolutePath; reason: UninstallConflictReason };

/** A conservative, side-effect-free uninstall plan; applying it lands in phase 7. */
export type UninstallPlan = {
  recordId: string;
  tool: string;
  actions: UninstallAction[];
  /** True when any action needs sudo for a root-owned entry (D8). */
  requiresSudo: boolean;
  /**
   * True when an actionable conflict blocks a fully clean uninstall. Detect-only (`detected`)
   * changes are reported but never set this: with backups off, a non-restorable mutation or
   * deletion must not keep a record alive forever (D2).
   */
  incomplete: boolean;
};

/** Inputs the planner verifies against before deciding anything. */
export type UninstallPlanContext = {
  /** Other records that also claim paths, for shared-ownership detection (D4). */
  otherRecords?: RecordV3[];
  /** Explicit user force past conflicts (D4). */
  force?: boolean;
  /** Reads the current state of a path; defaults to disk once the planner is implemented. */
  inspect?: (path: AbsolutePath) => UninstallVerification;
  /** Lists a directory's direct children; defaults to disk. Used to prove an owned directory is empty. */
  list?: (path: AbsolutePath) => AbsolutePath[];
};

/**
 * Plans an evidence-based uninstall from a record without touching disk (plan section 6). A
 * dry-run and the real uninstall share one plan, so they cannot diverge.
 */
export interface UninstallPlanner {
  plan(record: RecordV3, context?: UninstallPlanContext): Promise<UninstallPlan>;
}

/** sha256 hex of `bytes`, matching the content-address hashing used across the rewrite. */
function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Reads one path's current state without following symlinks: a symlink reports its target, a file
 * reports its content hash, and a directory reports only its kind. An unreadable file still reports
 * `exists` with `hash` unset, so the planner treats it as unverifiable rather than absent.
 */
export function inspectPath(path: AbsolutePath): UninstallVerification {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { exists: false };
  }

  if (stats.isSymbolicLink()) {
    let linkTarget: AbsolutePath | undefined;
    try {
      linkTarget = readlinkSync(path);
    } catch {
      // Keep the entry but leave the target unknown; the planner treats it as unverified.
    }
    return { exists: true, kind: "symlink", linkTarget, uid: stats.uid };
  }

  if (stats.isDirectory()) {
    return { exists: true, kind: "directory", uid: stats.uid };
  }

  try {
    return { exists: true, kind: "file", hash: sha256Hex(readFileSync(path)), uid: stats.uid };
  } catch {
    return { exists: true, kind: "file", uid: stats.uid };
  }
}

/** Lists a directory's direct children by absolute path; a missing or unreadable directory is empty. */
export function listChildren(path: AbsolutePath): AbsolutePath[] {
  try {
    return readdirSync(path).map((name) => join(path, name));
  } catch {
    return [];
  }
}

/** The numeric owner id of the running process, or undefined where the platform does not expose one. */
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Number of path segments, so a deeper entry is planned before the directory that holds it. */
function depth(path: AbsolutePath): number {
  return path.split("/").filter(Boolean).length;
}

/** Every path any record other than `selfId` claims, for shared-ownership detection (D4). */
function claimedByOthers(records: RecordV3[], selfId: string): Set<AbsolutePath> {
  const paths = new Set<AbsolutePath>();
  for (const record of records) {
    if (record.id === selfId) continue;
    for (const entry of record.owned) paths.add(entry.path);
    for (const entry of record.mutated) paths.add(entry.path);
    for (const entry of record.deleted) paths.add(entry.path);
  }
  return paths;
}

/**
 * The real planner: it verifies every owned, mutated, and deleted path against current disk state
 * before emitting anything, keeps diverged or shared paths unless `force` says otherwise, removes
 * an owned directory only when this record's own removals leave it empty, and restores only from a
 * before-image that still matches the recorded installed state. It never touches disk.
 */
export class VerifiedUninstallPlanner implements UninstallPlanner {
  constructor(
    private readonly inspect: (path: AbsolutePath) => UninstallVerification = inspectPath,
    private readonly list: (path: AbsolutePath) => AbsolutePath[] = listChildren,
  ) {}

  async plan(record: RecordV3, context: UninstallPlanContext = {}): Promise<UninstallPlan> {
    const inspect = context.inspect ?? this.inspect;
    const list = context.list ?? this.list;
    const force = context.force ?? false;
    const claimed = claimedByOthers(context.otherRecords ?? [], record.id);
    const actions: UninstallAction[] = [];
    // Paths the plan will leave absent, either by removing them or because they were already gone.
    const gone = new Set<AbsolutePath>();
    let requiresSudo = false;

    const sudoNeeded = (verification: UninstallVerification): boolean => {
      if (verification.uid === undefined) return record.privilege === "root";
      if (verification.uid === 0) return currentUid() !== 0;
      return false;
    };

    // Deepest first: a directory is planned only after every path that could empty it.
    const owned = record.owned.slice().sort((a, b) => depth(b.path) - depth(a.path));

    for (const entry of owned) {
      const verification = inspect(entry.path);

      if (!verification.exists) {
        actions.push({ action: "skip", path: entry.path, reason: "absent" });
        gone.add(entry.path);
        continue;
      }

      // Migrated v2 records stored paths without a kind or hash; ownership is unverifiable, so the
      // path is reported, never removed (contract: uninstall treats `unknown` as non-removable).
      if (entry.kind === "unknown") {
        actions.push({ action: "conflict", path: entry.path, reason: "unverified" });
        continue;
      }

      const shared = claimed.has(entry.path);
      if (shared && !force) {
        actions.push({ action: "conflict", path: entry.path, reason: "shared-owner" });
        continue;
      }

      if (entry.kind === "directory") {
        this.planDirectory(entry, verification, list, gone, actions, sudoNeeded, () => (requiresSudo = true));
        continue;
      }

      if (entry.kind === "symlink") {
        const action = planSymlink(entry, verification, force);
        actions.push(action);
        if (action.action === "remove") {
          gone.add(entry.path);
          if (sudoNeeded(verification)) requiresSudo = true;
        }
        continue;
      }

      const action = planFile(entry, verification, force);
      actions.push(action);
      if (action.action === "remove") {
        gone.add(entry.path);
        if (sudoNeeded(verification)) requiresSudo = true;
      }
    }

    // Mutations restore only from a before-image that still matches the recorded installed state.
    // Without a before-image the change is detect-only: report it, never block on it (D2).
    for (const entry of record.mutated) {
      const verification = inspect(entry.path);
      const action = planMutation(entry.path, entry.installedHash, entry.beforeBlob, verification, claimed, force);
      actions.push(action);
      if (action.action === "restore" && sudoNeeded(verification)) requiresSudo = true;
    }

    // Deletions restore only while the path is still absent; a recreated path is the user's. A
    // deletion with no before-image is likewise detect-only.
    for (const entry of record.deleted) {
      const verification = inspect(entry.path);
      actions.push(planDeletion(entry.path, entry.beforeBlob, verification, claimed, force));
    }

    return {
      recordId: record.id,
      tool: record.name,
      actions,
      requiresSudo,
      // Only actionable conflicts block; a `detected` (non-restorable) change never does.
      incomplete: actions.some((action) => action.action === "conflict"),
    };
  }

  /** Empties and removes an owned directory only when this plan's removals leave nothing behind. */
  private planDirectory(
    entry: OwnedEntry,
    verification: UninstallVerification,
    list: (path: AbsolutePath) => AbsolutePath[],
    gone: Set<AbsolutePath>,
    actions: UninstallAction[],
    sudoNeeded: (verification: UninstallVerification) => boolean,
    markSudo: () => void,
  ): void {
    if (verification.kind !== "directory") {
      actions.push({ action: "conflict", path: entry.path, reason: "diverged" });
      return;
    }

    const remaining = list(entry.path).filter((child) => !gone.has(child));
    if (remaining.length > 0) {
      // User files (or another record's) survive; the directory is never recursively deleted.
      actions.push({ action: "conflict", path: entry.path, reason: "not-empty" });
      return;
    }

    actions.push({ action: "remove", path: entry.path, kind: "directory" });
    gone.add(entry.path);
    if (sudoNeeded(verification)) markSudo();
  }
}

/** Plans one owned file: verified fingerprint removes it, a mismatch is kept unless forced. */
function planFile(entry: OwnedEntry, verification: UninstallVerification, force: boolean): UninstallAction {
  if (verification.kind !== "file") {
    return { action: "conflict", path: entry.path, reason: "diverged" };
  }
  if (verification.hash === undefined || entry.installedHash === undefined) {
    return force
      ? { action: "remove", path: entry.path, kind: "file" }
      : { action: "conflict", path: entry.path, reason: "unverified" };
  }
  if (verification.hash !== entry.installedHash) {
    return force
      ? { action: "remove", path: entry.path, kind: "file" }
      : { action: "conflict", path: entry.path, reason: "modified" };
  }
  return { action: "remove", path: entry.path, kind: "file" };
}

/** Plans one owned symlink: the recorded target must match what `readlink` reports now. */
function planSymlink(entry: OwnedEntry, verification: UninstallVerification, force: boolean): UninstallAction {
  if (verification.kind !== "symlink") {
    return { action: "conflict", path: entry.path, reason: "diverged" };
  }
  if (entry.linkTarget === undefined || verification.linkTarget === undefined) {
    return force
      ? { action: "remove", path: entry.path, kind: "symlink" }
      : { action: "conflict", path: entry.path, reason: "unverified" };
  }
  if (entry.linkTarget !== verification.linkTarget) {
    return force
      ? { action: "remove", path: entry.path, kind: "symlink" }
      : { action: "conflict", path: entry.path, reason: "modified" };
  }
  return { action: "remove", path: entry.path, kind: "symlink" };
}

/**
 * Plans one mutation. A before-image is required to restore; without one the change is detect-only
 * and reported rather than blocking. With a before-image, the current bytes must still equal the
 * recorded installed hash (and a hash must exist) before uninstall will overwrite them.
 */
function planMutation(
  path: AbsolutePath,
  installedHash: string | undefined,
  beforeBlob: BlobId | undefined,
  verification: UninstallVerification,
  claimed: Set<AbsolutePath>,
  force: boolean,
): UninstallAction {
  if (claimed.has(path) && !force) return { action: "conflict", path, reason: "shared-owner" };
  // No before-image: nothing to restore from, so the install's edit is detectable but not
  // reversible. Report it as informational instead of a permanent `missing-blob` conflict (D2).
  if (beforeBlob === undefined) return { action: "detected", path, kind: "mutated" };
  if (!verification.exists) return { action: "conflict", path, reason: "diverged" };
  if (verification.hash === undefined) return { action: "conflict", path, reason: "unreadable" };
  if (installedHash !== undefined && verification.hash !== installedHash)
    return { action: "conflict", path, reason: "diverged" };
  if (installedHash === undefined) return { action: "conflict", path, reason: "unverified" };
  return { action: "restore", path, kind: verification.kind ?? "file", beforeBlob, expect: "installed", installedHash };
}

/** Plans one deletion: restore only while the path is still absent and a before-image exists. */
function planDeletion(
  path: AbsolutePath,
  beforeBlob: BlobId | undefined,
  verification: UninstallVerification,
  claimed: Set<AbsolutePath>,
  force: boolean,
): UninstallAction {
  if (claimed.has(path) && !force) return { action: "conflict", path, reason: "shared-owner" };
  // As with a mutation, a deletion without a before-image cannot be reversed; report it, don't block.
  if (beforeBlob === undefined) return { action: "detected", path, kind: "deleted" };
  if (verification.exists) return { action: "conflict", path, reason: "diverged" };
  return { action: "restore", path, kind: "file", beforeBlob, expect: "absent" };
}

/**
 * Renders a plan as stable lines. `dry-run` and `apply` share the same action order and the same
 * per-action logic, so a dry run cannot enumerate anything the real run would not attempt.
 */
export function formatUninstallPlan(plan: UninstallPlan, mode: "dry-run" | "apply"): string[] {
  return plan.actions.map((action) => {
    switch (action.action) {
      case "remove":
        return mode === "dry-run" ? `would remove ${action.path}` : `remove ${action.path}`;
      case "restore":
        return mode === "dry-run" ? `would restore ${action.path}` : `restore ${action.path}`;
      case "skip":
        return `skip ${action.path} (${action.reason})`;
      case "detected":
        // Detect-only: the install changed this path but captured no before-image, so there is no
        // restore to plan. Say so plainly in both dry-run and apply mode.
        return action.kind === "deleted"
          ? `detected ${action.path} was removed during install (not restored; no before-image was captured)`
          : `detected ${action.path} changed during install (not restored; no before-image was captured)`;
      case "conflict":
        return mode === "dry-run" ? `conflict ${action.path} (${action.reason})` : `keep ${action.path} (${action.reason})`;
    }
  });
}
