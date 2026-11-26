import { EXCLUDED_PATHS, isExcludedDirName } from "../../../constants";
import type { AbsolutePath } from "../../../types";
import { join } from "node:path";

/**
 * Path-boundary rules for the Linux capture pipeline. `normalizeAbsolutePath` collapses lexical
 * `.` and `..` (`..` at the root stays at the root), and `inRoots` checks the lexical scope.
 * These are prefilters, not substitutes for kernel path resolution.
 *
 * Neither helper can see a symlinked path component: the pure tracer parser keeps the traced
 * spelling, and `reconstruct.ts` resolves the parent against the real filesystem
 * (`FsInspector.resolve`) before a path is recorded, so a path that leaves the roots through a
 * symlinked component is dropped instead of recorded.
 */

/** The absolute path with `.`/`..` collapsed; `undefined` for a non-absolute input. */
export function normalizeAbsolutePath(path: string): AbsolutePath | undefined {
  if (!path.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Whether `path` is `root` itself or a descendant of it, without matching `/usr` for `/usrx`. */
export function inRoots(path: AbsolutePath, roots: AbsolutePath[]): boolean {
  return roots.some((root) => {
    if (path === root) return true;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix);
  });
}

/**
 * Whether an ancestor directory of `path` is one the shared exclusion rules skip at any depth
 * (`EXCLUDED_DIR_NAMES`/`EXCLUDED_DIR_NAME_PATTERN`), matching the scoped snapshot walk. The final
 * segment is deliberately not checked: an excluded directory is itself recorded (the baseline walk
 * records it without descending), so a `mkdir` of `node_modules` stays an owned directory while its
 * untracked payload does not.
 */
export function hasExcludedAncestor(path: AbsolutePath): boolean {
  const segments = path.split("/");
  for (let index = 1; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment !== undefined && isExcludedDirName(segment)) return true;
  }
  return false;
}


export function linuxObservationExcluded(roots: AbsolutePath[], home = process.env.HOME) {
  const homeExclusions = home ? EXCLUDED_PATHS.map((path) => join(home, path)) : [];
  const specificFirst = [...roots].sort((a, b) => b.length - a.length);
  return (path: AbsolutePath): boolean => {
    const root = specificFirst.find((candidate) => inRoots(path, [candidate]));
    if (!root) return true;
    if (homeExclusions.some((excluded) => inRoots(path, [excluded]) && !inRoots(root, [excluded]))) return true;
    return hasExcludedAncestor(`/${path.slice(root.length).replace(/^\//, "")}`);
  };
}
