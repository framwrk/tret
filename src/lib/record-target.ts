// One record's effective uninstall target (plan 03 items 1 and 3).
//
// A record's raw owned/mutated/deleted lists can name paths Tret must not plan to delete: a package
// manager's shared global state, or a first-party managed install's payload. Uninstall, inspect, and
// a tracked-tool update all need the same filtered view before they plan anything, so the filtering
// lives here once. A record written before `managedBy`/`managedInstall` existed is recognized from
// its executable, matching the detection uninstall already does, so all three commands agree.

import type { AbsolutePath, ManagedInstall, ManagedPackage, RecordV3 } from "../types";
import { describeManagedInstall, detectManagedInstall, withoutManagedInstallPaths } from "./managed-install";
import {
  describeManagedPackage,
  detectManagedPackage,
  managedPackageRemovalScope,
  withoutManagedGlobalPaths,
} from "./package-manager";

/** A record reduced to what Tret may actually remove, plus the managed layouts it reports as unresolved. */
export type RecordTarget = {
  /** The record with managed shared paths dropped from `owned`, `mutated`, and `deleted`. */
  record: RecordV3;
  /** Recognized package-manager state; this never grants manager execution authority. */
  managedBy?: ManagedPackage;
  /** Recognized managed root; this never grants recursive removal authority. */
  managedInstall?: ManagedInstall;
};

/**
 * Reduces `record` to the paths Tret may remove or restore. A managed package's shared global root
 * and a managed install's root subtree are dropped and reported as unresolved; the bin shim,
 * launcher, and other owned paths outside those roots stay in the reduced record. Legacy detection
 * is in memory only; blocked callers preserve the original record without saving this view.
 */
export function recordTarget(record: RecordV3, home: AbsolutePath | undefined = Bun.env.HOME): RecordTarget {
  const managedBy = record.managedBy ?? detectManagedPackage(record.executable, record.owned);
  const managedInstall = record.managedInstall ?? detectManagedInstall(record.executable, record.owned);

  let target = record;
  if (managedBy !== undefined) {
    target = {
      ...target,
      managedBy: target.managedBy ?? managedBy,
      owned: withoutManagedGlobalPaths(target.owned, managedBy, home),
      mutated: withoutManagedGlobalPaths(target.mutated, managedBy, home),
      deleted: withoutManagedGlobalPaths(target.deleted, managedBy, home),
    };
  }
  if (managedInstall !== undefined) {
    target = {
      ...target,
      managedInstall: target.managedInstall ?? managedInstall,
      owned: withoutManagedInstallPaths(target.owned, managedInstall),
      mutated: withoutManagedInstallPaths(target.mutated, managedInstall),
      deleted: withoutManagedInstallPaths(target.deleted, managedInstall),
    };
  }

  return {
    record: target,
    ...(managedBy === undefined ? {} : { managedBy }),
    ...(managedInstall === undefined ? {} : { managedInstall }),
  };
}

/** The delegated scopes an uninstall or update must not overlap: the package's shared root and the managed install's root. */
export function delegatedScopes(target: RecordTarget, home: AbsolutePath | undefined = Bun.env.HOME): AbsolutePath[] {
  const scopes: AbsolutePath[] = [];
  if (target.managedBy !== undefined) {
    const scope = managedPackageRemovalScope(target.managedBy, home);
    if (scope !== undefined) scopes.push(scope);
  }
  if (target.managedInstall !== undefined) scopes.push(target.managedInstall.root);
  return scopes;
}

/** Recognition is evidence of a layout, never authority over its payload or manager lifecycle. */
export function delegatedRemovalBlocks(target: RecordTarget): string[] {
  const reasons: string[] = [];
  if (target.managedBy !== undefined) {
    reasons.push(
      `package ${describeManagedPackage(target.managedBy)} has no verified removal authority or bounded manager scope; manual reconciliation is required`,
    );
  }
  if (target.managedInstall !== undefined) {
    reasons.push(
      `managed install ${describeManagedInstall(target.managedInstall)} has no verified payload inventory; manual reconciliation is required`,
    );
  }
  return reasons;
}
