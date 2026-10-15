import type { AbsolutePath, RecordV3 } from "../types";
import { resolve, sep } from "node:path";
import { managedPackageRemovalScope } from "./package-manager";

/** One record path that would be affected by a delegated removal. */
export type DelegatedRemovalConflict = {
  scope: AbsolutePath;
  path: AbsolutePath;
  recordName: string;
};

type RecordClaim = {
  path: AbsolutePath;
  /** Managed scopes claim their whole subtree, so a parent scope also overlaps its descendants. */
  recursive?: boolean;
};

/** Finds the first claim from another record inside each delegated removal scope. */
export function findDelegatedRemovalConflicts(
  scopes: readonly AbsolutePath[],
  records: readonly RecordV3[],
  removingRecord: RecordV3,
  home: AbsolutePath | undefined,
): DelegatedRemovalConflict[] {
  const conflicts: DelegatedRemovalConflict[] = [];

  for (const scope of scopes) {
    for (const record of records) {
      if (record === removingRecord) continue;

      // A scope and a claim that differ only by case name the same tree wherever either record's
      // filesystem is case-insensitive (D10), so the overlap check folds then and only then;
      // missing that overlap would let a recursive removal touch another record's tree.
      const foldCase = !removingRecord.caseSensitive || !record.caseSensitive;
      const claim = recordClaims(record, home).find((candidate) =>
        candidate.recursive ? scopesOverlap(candidate.path, scope, foldCase) : isWithinScope(candidate.path, scope, foldCase),
      );
      if (claim !== undefined) {
        conflicts.push({ scope, path: claim.path, recordName: record.name });
        break;
      }
    }
  }

  return conflicts;
}

/** Formats an overlap for uninstall and forced-reinstall diagnostics. */
export function formatDelegatedRemovalConflict(conflict: DelegatedRemovalConflict): string {
  return `conflict: delegated removal of ${conflict.scope} overlaps ${conflict.path}, claimed by ${conflict.recordName}`;
}

function* recordClaims(record: RecordV3, home: AbsolutePath | undefined): Generator<RecordClaim> {
  if (record.executable !== "") yield { path: record.executable };
  for (const entry of record.owned) yield { path: entry.path };
  for (const entry of record.mutated) yield { path: entry.path };
  for (const entry of record.deleted) yield { path: entry.path };
  if (record.managedInstall !== undefined) yield { path: record.managedInstall.root, recursive: true };

  if (record.managedBy !== undefined) {
    const packageScope = managedPackageRemovalScope(record.managedBy, home);
    if (packageScope !== undefined) yield { path: packageScope, recursive: true };
  }
}

function isWithinScope(path: AbsolutePath, scope: AbsolutePath, foldCase: boolean): boolean {
  const normalize = (value: AbsolutePath): string => {
    const resolved = resolve(value);
    return foldCase ? resolved.toLowerCase() : resolved;
  };
  const normalizedPath = normalize(path);
  const normalizedScope = normalize(scope);
  const childPrefix = normalizedScope.endsWith(sep) ? normalizedScope : `${normalizedScope}${sep}`;
  return normalizedPath === normalizedScope || normalizedPath.startsWith(childPrefix);
}

function scopesOverlap(first: AbsolutePath, second: AbsolutePath, foldCase: boolean): boolean {
  return isWithinScope(first, second, foldCase) || isWithinScope(second, first, foldCase);
}
