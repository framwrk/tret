import type { AbsolutePath } from "../types";
import { SNAPSHOT_ROOTS } from "../constants";
import { join } from "node:path";
import { readdirSync } from "node:fs";

// Directories where tools keep their own files and folders, home-relative like EXCLUDED_PATHS.
const SEARCH_DIRS_IN_HOME = [
  ".cache",
  ".config",
  ".local/bin",
  ".local/share",
  ".local/state",
  "Library/Application Support",
  "Library/Caches",
  "Library/Containers",
  "Library/HTTPStorages",
  "Library/LaunchAgents",
  "Library/Logs",
  "Library/Preferences",
  "Library/Saved Application State",
  "Library/WebKit",
];

/**
 * Finds every file and folder that belongs to a tool: the executable it runs as, its dot folder
 * under `$HOME`, and tool-named entries in the standard tool directories. Only the top-most path
 * of a nest is returned, matching what `diff()` records for an install.
 */
export function findRelated(name: string, executable: AbsolutePath): AbsolutePath[] {
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  const found = new Set<AbsolutePath>([executable]);
  addToolEntries(home, name, found);
  for (const dir of SEARCH_DIRS_IN_HOME) addToolEntries(join(home, dir), name, found);
  for (const dir of SNAPSHOT_ROOTS) addToolEntries(dir, name, found);
  return topMost([...found].sort());
}

/** Collects the tool's own entries in one directory; a directory that cannot be read is skipped. */
function addToolEntries(dir: AbsolutePath, name: string, found: Set<AbsolutePath>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (belongsTo(entry, name)) found.add(join(dir, entry));
  }
}

/** True when an entry is the tool's: `mytool`, `mytool.plist`, `.mytool`, or `.mytoolrc`. */
function belongsTo(entry: string, name: string): boolean {
  const base = entry.toLowerCase().replace(/^\./, "");
  const wanted = name.toLowerCase();
  return base === wanted || base === `${wanted}rc` || base.startsWith(`${wanted}.`);
}

/** Drops every path nested inside another match, so a recorded folder already covers its contents. */
function topMost(paths: AbsolutePath[]): AbsolutePath[] {
  const kept: AbsolutePath[] = [];
  for (const path of paths) {
    if (!kept.some((parent) => path.startsWith(`${parent}/`))) kept.push(path);
  }
  return kept;
}
