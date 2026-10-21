// One record's effective uninstall target (plan 03 items 1 and 3).
//
// A record's raw owned/mutated/deleted lists can name paths Tret must not plan to delete: a package
// manager's shared global state, or a first-party managed install's payload. Uninstall, inspect, and
// a tracked-tool update all need the same filtered view before they plan anything, so the filtering
// lives here once. A record written before `managedBy`/`managedInstall` existed is recognized from
// its executable, matching the detection uninstall already does, so all three commands agree.

import type { AbsolutePath, ManagedInstall, ManagedPackage, RecordV3 } from "../types";
import { detectManagedInstall, withoutManagedInstallPaths } from "./managed-install";
import { detectManagedPackage, managedPackageRemovalScope, withoutManagedGlobalPaths } from "./package-manager";

/** A record reduced to what Tret may actually remove, plus the managed layouts it defers to. */
export type RecordTarget = {
  /** The record with managed shared paths dropped from `owned`, `mutated`, and `deleted`. */
  record: RecordV3;
  /** The package-manager global state delegated to the manager, when there is one. */
  managedBy?: ManagedPackage;
  /** The first-party managed root delegated to a recursive removal, when there is one. */
  managedInstall?: ManagedInstall;
};

/**
 * Reduces `record` to the paths Tret may remove or restore. A managed package's shared global root
 * and a managed install's root subtree are dropped and reported as delegated instead; the bin shim,
 * launcher, and other owned paths outside those roots stay in the reduced record. The detected
 * values are stamped onto the reduced record so a later save keeps delegating.
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
