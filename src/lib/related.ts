import type { AbsolutePath } from "../types";
import { MACOS_PLATFORM } from "./platform";
import { join } from "node:path";
import { readdirSync } from "node:fs";

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
  for (const dir of MACOS_PLATFORM.searchRootsInHome) addToolEntries(join(home, dir), name, found);
  for (const dir of MACOS_PLATFORM.searchRootsAbsolute) addToolEntries(dir, name, found);
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
