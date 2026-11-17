import { CaptureBudget, CaptureBudgetError } from "./capture/budget";
import type { AbsolutePath } from "../types";
import type { Platform } from "./platform";
import { currentPlatform } from "./platform";
import { join } from "node:path";
import { opendirSync } from "node:fs";

/** The actual shallow discovery roots, de-duplicated before any enumeration. */
export function relatedSearchRoots(platform: Platform = currentPlatform(), home = Bun.env.HOME): AbsolutePath[] {
  if (!home) throw new Error("HOME is not set");
  return [...new Set([home, ...platform.searchRootsInHome.map(dir => join(home, dir)), ...platform.searchRootsAbsolute])].sort();
}

/** Name matches are candidate observations only, never proof of ownership or disposal authority. */
export function findRelated(
  name: string,
  executable: AbsolutePath,
  platform: Platform = currentPlatform(),
  budget = new CaptureBudget(),
): AbsolutePath[] {
  budget.ensurePhase();
  const found = new Set<AbsolutePath>([executable]);
  for (const dir of relatedSearchRoots(platform)) addToolEntries(dir, name, found, budget);
  return topMost([...found].sort(), budget);
}

/** Stream all entries, including nonmatches: discovery work is part of the inventory's budget. */
function addToolEntries(dir: AbsolutePath, name: string, found: Set<AbsolutePath>, budget: CaptureBudget): void {
  budget.inspect(dir);
  let directory;
  try {
    directory = opendirSync(dir, { bufferSize: 32 });
    for (;;) {
      budget.check();
      const entry = directory.readSync();
      if (!entry) break;
      const path = join(dir, entry.name);
      budget.inspect(path);
      if (belongsTo(entry.name, name)) found.add(path);
    }
  } catch (error) {
    if (error instanceof CaptureBudgetError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (directory || (code !== "ENOENT" && code !== "ENOTDIR"))
      budget.note(`discovery directory unreadable: ${dir}: ${String(error)}`);
  } finally { directory?.closeSync(); }
}

/** True when an entry is the tool's: `mytool`, `mytool.plist`, `.mytool`, or `.mytoolrc`. */
function belongsTo(entry: string, name: string): boolean {
  const base = entry.toLowerCase().replace(/^\./, "");
  const wanted = name.toLowerCase();
  return base === wanted || base === `${wanted}rc` || base.startsWith(`${wanted}.`);
}

/** Test ancestor membership instead of comparing every match against every earlier sibling. */
function topMost(paths: AbsolutePath[], budget: CaptureBudget): AbsolutePath[] {
  const kept = new Set<AbsolutePath>();
  for (const path of paths) {
    budget.check();
    let nested = false;
    for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1)) {
      budget.check();
      if (kept.has(path.slice(0, end))) { nested = true; break; }
    }
    if (!nested) kept.add(path);
  }
  return [...kept];
}
