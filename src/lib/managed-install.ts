import type { AbsolutePath, ManagedInstall, OwnedEntry } from "../types";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

// Managed-install recognition keeps skipped payloads visible and out of ordinary file cleanup.
// A matching marker or root shape never authorizes recursive removal of its descendants.
//
// Detection leans on the launcher the installer leaves under `<agent>/bin/<cmd>`, with the managed
// root as its sibling `<agent>/install`. A PATH entrypoint symlink is resolved first, so a command
// reached through the symlink is recognized the same way the installer's own uninstaller resolves it.

/** One recognized managed-install layout: the marker that identifies it and where its root can be. */
type ManagedInstallLayout = {
  /** Marker `kind` that identifies the layout. */
  kind: string;
  /** Marker `schemaVersion` this build understands. */
  schemaVersion: number;
  /** Marker `layout` name. */
  layout: string;
  /** Marker filename at the managed root. */
  marker: string;
  /** Candidate roots to probe, given the fully symlink-resolved command path. */
  rootCandidates: (resolved: AbsolutePath) => AbsolutePath[];
  /**
   * Structural check for a real root of this layout. A matching marker alone is not enough: without
   * this, a stray marker in a home or shared directory would misidentify the managed scope.
   */
  hasRootShape: (root: AbsolutePath) => boolean;
};

const PI_MARKER = "managed-install.json";

/**
 * Known managed-install layouts. Today this is the Pi managed installer
 * (`kind: pi-managed-install`, `layout: releases-v1`); the registry shape is the same as the package
 * manager table, so another first-party layout is one entry, not a scattered edit.
 */
const LAYOUTS: ManagedInstallLayout[] = [
  {
    kind: "pi-managed-install",
    schemaVersion: 1,
    layout: "releases-v1",
    marker: PI_MARKER,
    rootCandidates: (resolved) => {
      const dir = dirname(resolved);
      const candidates = [dir];
      // The launcher lives in `<agent>/bin`, and the managed root is the sibling `<agent>/install`.
      if (basename(dir) === "bin") candidates.push(join(dirname(dir), "install"));
      return candidates;
    },
    hasRootShape: (root) => basename(root) === "install" && basename(dirname(root)) === "agent",
  },
];

/** The JSON marker's fields we read; other fields (`entrypoint`, …) are ignored. */
type Marker = { kind?: unknown; schemaVersion?: unknown; layout?: unknown };

/**
 * Detects whether `executable` is a first-party managed-install launcher and, if so, which layout
 * and root. The recorded owned entry supplies a symlink target when the record is available;
 * otherwise the file on disk is resolved. Returns undefined for a normal binary or an unrecognized
 * layout, so a missed detection degrades to ordinary file ownership rather than a wrong removal.
 */
export function detectManagedInstall(executable: AbsolutePath, owned: readonly OwnedEntry[] = []): ManagedInstall | undefined {
  if (executable === "") return undefined;
  const resolved = resolveCommandPath(executable, owned);
  for (const layout of LAYOUTS) {
    for (const candidate of layout.rootCandidates(resolved)) {
      if (layout.hasRootShape(candidate) && markerMatches(candidate, layout)) {
        return { kind: layout.kind, layout: layout.layout, root: candidate };
      }
    }
  }
  return undefined;
}

/** True when `path` is the managed root or sits under it (the payload Tret never owns). */
export function isManagedInstallPath(path: AbsolutePath, managed: ManagedInstall): boolean {
  return path === managed.root || path.startsWith(`${managed.root}/`);
}

/**
 * Keeps only the entries a record may own from a managed install: the whole root subtree (the
 * marker, release payload, staging, and `current-version`) is excluded from ordinary cleanup. The unresolved
 * root stays visible; no recursive removal is supported.
 */
export function withoutManagedInstallPaths<T extends { path: AbsolutePath }>(
  entries: readonly T[],
  managed: ManagedInstall,
): T[] {
  return entries.filter((entry) => !isManagedInstallPath(entry.path, managed));
}

/** A short label for a managed install, used in install/uninstall output. */
export function describeManagedInstall(managed: ManagedInstall): string {
  return `${managed.kind} at ${managed.root}`;
}

/** Whether a root's marker still matches a layout: kind, schemaVersion, and layout all agree. */
function markerMatches(root: AbsolutePath, layout: ManagedInstallLayout): boolean {
  const marker = readMarker(join(root, layout.marker));
  return marker?.kind === layout.kind && marker.schemaVersion === layout.schemaVersion && marker.layout === layout.layout;
}

/** Reads and parses a marker file; a missing, unreadable, or invalid marker is undefined. */
function readMarker(path: AbsolutePath): Marker | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Marker;
  } catch {
    return undefined;
  }
}

/**
 * The command's real path: the recorded symlink target when the record supplies one, then any
 * on-disk symlink chain (a PATH entrypoint pointing at the launcher), bounded to avoid a cycle.
 */
function resolveCommandPath(executable: AbsolutePath, owned: readonly OwnedEntry[]): AbsolutePath {
  const recorded = owned.find((entry) => entry.path === executable)?.linkTarget;
  let current = recorded === undefined ? executable : absolutize(dirname(executable), recorded);

  for (let hop = 0; hop < 40; hop++) {
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      current = absolutize(dirname(current), readlinkSync(current));
    } catch {
      break;
    }
  }
  return current;
}

/** Resolves a possibly-relative symlink target against the directory holding the link. */
function absolutize(base: AbsolutePath, target: AbsolutePath): AbsolutePath {
  return isAbsolute(target) ? target : resolve(base, target);
}
