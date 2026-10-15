import type { AbsolutePath, OwnedEntry } from "../types";
import { inspectPath, listChildren } from "./uninstall-planner";

/**
 * Fingerprints every adopted path and, beneath an adopted directory, every node it holds (plan 02
 * item 7). A `find` record has no install journal, so each node's current state is the only evidence
 * a later uninstall can check; recording the whole tree lets it remove the files whose fingerprint
 * still matches and then the directories that become empty, while a changed file, an unreadable one,
 * or an unrelated survivor becomes a conflict naming that path instead of an opaque, permanently
 * stuck folder record. Symlinks are recorded by target and never followed, so a link out of an
 * adopted folder stays one entry rather than adopting the tree it points at.
 */
export function adoptedEntries(paths: AbsolutePath[]): OwnedEntry[] {
  const entries = new Map<AbsolutePath, OwnedEntry>();
  for (const path of paths) collectEntries(path, entries);
  return [...entries.values()].sort((a, b) => comparePaths(a.path, b.path));
}

function collectEntries(path: AbsolutePath, entries: Map<AbsolutePath, OwnedEntry>): void {
  if (entries.has(path)) return;

  const verification = inspectPath(path);
  const entry: OwnedEntry = { path, kind: verification.kind ?? "unknown" };
  if (verification.linkTarget !== undefined) entry.linkTarget = verification.linkTarget;
  if (verification.hash !== undefined) entry.installedHash = verification.hash;
  entries.set(path, entry);

  if (verification.kind !== "directory") return;
  for (const child of listChildren(path)) collectEntries(child, entries);
}

/** Compares two absolute paths by code unit for a stable, locale-independent record order. */
function comparePaths(a: AbsolutePath, b: AbsolutePath): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
