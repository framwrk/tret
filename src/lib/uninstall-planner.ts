import type { AbsolutePath, OwnedKind, RecordV3 } from "../types";
import type { BlobId } from "./storage";

/** Current on-disk state of one path, used to verify before removing or restoring it. */
export type UninstallVerification = {
  exists: boolean;
  kind?: OwnedKind;
  /** sha256 of the current content, when present and readable. */
  hash?: string;
};

/** Why a path is skipped without changing it. */
export type UninstallSkipReason = "absent" | "not-owned" | "already-empty";

/** Why a path needs the user's attention instead of being changed. */
export type UninstallConflictReason = "modified" | "shared-owner" | "diverged" | "missing-blob" | "unreadable";

/** One planned uninstall step: the planner only ever emits these four shapes. */
export type UninstallAction =
  | { action: "remove"; path: AbsolutePath; kind: OwnedKind }
  | { action: "restore"; path: AbsolutePath; kind: OwnedKind; beforeBlob: BlobId }
  | { action: "skip"; path: AbsolutePath; reason: UninstallSkipReason }
  | { action: "conflict"; path: AbsolutePath; reason: UninstallConflictReason };

/** A conservative, side-effect-free uninstall plan; applying it lands in phase 7. */
export type UninstallPlan = {
  recordId: string;
  tool: string;
  actions: UninstallAction[];
  /** True when any action needs sudo for a root-owned entry (D8). */
  requiresSudo: boolean;
  /** True when a conflict blocks a fully clean uninstall. */
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
};

/**
 * Plans an evidence-based uninstall from a record without touching disk (plan section 6). A
 * dry-run and the real uninstall share one plan, so they cannot diverge.
 */
export interface UninstallPlanner {
  plan(record: RecordV3, context?: UninstallPlanContext): Promise<UninstallPlan>;
}
