import type { AbsolutePath } from "../../../types";

/**
 * Path-boundary rules for the Linux capture pipeline. `normalizeAbsolutePath` collapses `.` and
 * `..` the way the kernel resolves a path lexically (`..` at the root stays at the root), and
 * `inRoots` decides whether a normalized path is inside an observe root.
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
