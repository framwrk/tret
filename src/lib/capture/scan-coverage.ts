import { dirname } from "node:path";

/** Absence is established only by a missing root or a fully enumerated parent. */
export type ScanCoverage = {
  completeDirectories: Set<string>;
  absentRoots: Set<string>;
  unknownPaths: Set<string>;
  excludedPaths?: ReadonlySet<string>;
};

export function newScanCoverage(): ScanCoverage {
  return { completeDirectories: new Set(), absentRoots: new Set(), unknownPaths: new Set() };
}

export function scanPresence(
  path: string,
  entries: ReadonlyMap<string, unknown>,
  coverage: ScanCoverage,
): "present" | "absent" | "unknown" {
  if (entries.has(path) || coverage.completeDirectories.has(path)) return "present";
  let current = path;
  for (;;) {
    if (coverage.unknownPaths.has(current) || coverage.excludedPaths?.has(current)) return "unknown";
    if (coverage.absentRoots.has(current)) return "absent";
    const parent = dirname(current);
    if (coverage.completeDirectories.has(parent) && !entries.has(current)) return "absent";
    if (entries.has(current) || parent === current) return "unknown";
    current = parent;
  }
}
