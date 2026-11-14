import type { UninstallPlan, UninstallPlanner } from "./uninstall-planner";
import { delegatedRemovalBlocks, delegatedScopes, recordTarget } from "./record-target";
import { findDelegatedRemovalConflicts, formatDelegatedRemovalConflict } from "./delegated-removal";
import type { RecordV3 } from "../types";
import type { Storage } from "./storage";
import { VerifiedUninstallPlanner } from "./uninstall-planner";
import { unverifiedShellEdits } from "./shellconfig";

export type CleanupPlanOptions = {
  home?: string;
  force?: boolean;
  approvedOnly?: boolean;
  getBlob?: Storage["getBlob"];
  planner?: UninstallPlanner;
};

/** One read-only scope/preflight builder for inspect, dry-run, uninstall and replacement. */
export async function buildCleanupPlan(record: RecordV3, records: RecordV3[], options: CleanupPlanOptions = {}) {
  const home = options.home ?? process.env.HOME;
  const target = recordTarget(record, home);
  const conflicts = findDelegatedRemovalConflicts(delegatedScopes(target, home), records, record, home).map(
    formatDelegatedRemovalConflict,
  );
  const blocked = delegatedRemovalBlocks(target);
  const blockedShell = unverifiedShellEdits(target.record, undefined, home);
  const fullPlan = await (options.planner ?? new VerifiedUninstallPlanner()).plan(target.record, {
    otherRecords: records,
    home,
    force: options.force,
    ...(options.getBlob ? { getBlob: options.getBlob } : {}),
  });
  const approvedPaths = new Set(
    target.record.evidence?.filter((entry) => entry.authority === "user-approved").map((entry) => entry.path),
  );
  const retained = options.approvedOnly
    ? fullPlan.actions
        .filter((action) => !approvedPaths.has(action.path))
        .map((action) => ({
          path: action.path,
          reason: action.action === "conflict" || action.action === "skip" ? action.reason : "outside-approved-scope",
        }))
    : [];
  if (options.approvedOnly)
    for (const path of delegatedScopes(target, home)) retained.push({ path, reason: "unverified-managed-scope" });
  const globallyBlocked = !options.approvedOnly && (conflicts.length > 0 || blocked.length > 0 || blockedShell.length > 0);
  const selected = options.approvedOnly
    ? fullPlan.actions.filter((action) => approvedPaths.has(action.path))
    : fullPlan.actions;
  const actions = globallyBlocked
    ? selected.map((action) =>
        action.action === "remove" || action.action === "restore"
          ? { action: "conflict" as const, path: action.path, reason: "scope-unverified" as const }
          : action,
      )
    : selected;
  const plan: UninstallPlan = {
    ...fullPlan,
    actions,
    retained,
    scope: options.approvedOnly ? "approved-effects" : "recorded-effects",
    incomplete: globallyBlocked || actions.some((action) => action.action === "conflict"),
    requiresSudo:
      !globallyBlocked &&
      fullPlan.requiresSudo &&
      actions.some((action) => action.action === "remove" || action.action === "restore"),
  };
  return { target, plan, fullPlan, conflicts, blocked, blockedShell };
}
