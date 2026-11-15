import type { AbsolutePath, OwnedEntry } from "../types";
import { CaptureBudget, CaptureBudgetError } from "./capture/budget";
import { lstatSync, opendirSync, readlinkSync } from "node:fs";
import { hashBoundedContentSync } from "./capture/content";
import { privateStateFilter } from "./capture/self-state";

/**
 * Fingerprints every adopted path and, beneath an adopted directory, every node it holds (plan 02
 * item 7). A `find` record has no install journal, so each node's current state is the only evidence
 * a later uninstall can check; recording the whole tree lets it remove the files whose fingerprint
 * still matches and then the directories that become empty, while a changed file, an unreadable one,
 * or an unrelated survivor becomes a conflict naming that path instead of an opaque, permanently
 * stuck folder record. Symlinks are recorded by target and never followed, so a link out of an
 * adopted folder stays one entry rather than adopting the tree it points at.
 */
export function adoptedEntries(
  paths: AbsolutePath[],
  budget = new CaptureBudget(),
  skip?: (path: string) => boolean,
): OwnedEntry[] {
  budget.ensurePhase();
  const entries = new Map<AbsolutePath, OwnedEntry>();
  const privateState = privateStateFilter();
  for (const path of paths) collectEntries(path, entries, budget, (path) => privateState(path) || skip?.(path) === true);
  budget.check();
  return [...entries.values()].sort((a, b) => comparePaths(a.path, b.path));
}

function collectEntries(
  path: AbsolutePath,
  entries: Map<AbsolutePath, OwnedEntry>,
  budget: CaptureBudget,
  skip: (path: string) => boolean,
  depth = 0,
): void {
  budget.depth(depth);
  if (entries.has(path) || skip(path)) return;
  budget.inspect(path);

  let node;
  try {
    node = lstatSync(path);
  } catch (error) {
    budget.note(`adoption state unknown: ${path}: ${String(error)}`);
  }
  const entry: OwnedEntry = {
    path,
    kind: !node
      ? "unknown"
      : node.isFile()
        ? "file"
        : node.isSymbolicLink()
          ? "symlink"
          : node.isDirectory()
            ? "directory"
            : "unknown",
  };
  if (entry.kind === "file") entry.installedHash = hashBoundedContentSync(path, { budget });
  if (entry.kind === "symlink") {
    try {
      entry.linkTarget = readlinkSync(path);
    } catch (error) {
      entry.kind = "unknown";
      budget.note(`adoption link unknown: ${path}: ${String(error)}`);
    }
  }
  budget.event(entry);
  entries.set(path, entry);

  if (entry.kind !== "directory") return;
  let directory;
  try {
    directory = opendirSync(path, { bufferSize: 32 });
    for (;;) {
      budget.check();
      const child = directory.readSync();
      if (!child) break;
      collectEntries(`${path}/${child.name}`, entries, budget, skip, depth + 1);
    }
  } catch (error) {
    if (error instanceof CaptureBudgetError) throw error;
    budget.note(`adoption directory unreadable: ${path}: ${String(error)}`);
  } finally {
    directory?.closeSync();
  }
}

/** Compares two absolute paths by code unit for a stable, locale-independent record order. */
function comparePaths(a: AbsolutePath, b: AbsolutePath): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
