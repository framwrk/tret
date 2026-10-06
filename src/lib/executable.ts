import type { AbsolutePath } from "../types";
import { Glob } from "bun";
import { SCAN_OPTIONS } from "../constants";
import { lstatSync } from "node:fs";

/** Resolves a command name to its path on PATH, or undefined when no such command exists. */
export function resolveCommand(name: string): AbsolutePath | undefined {
  return Bun.which(name) ?? undefined;
}

/** Picks the most likely installed binary among the changes: something in a bin folder first, then any executable. */
export function pickExecutable(added: AbsolutePath[]): AbsolutePath | undefined {
  const candidates = added.flatMap((path) => (isDirectory(path) ? executablesUnder(path) : isExecutable(path) ? [path] : []));
  const rank = (path: AbsolutePath): number => (path.split("/").at(-2) === "bin" ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0];
}

/** Collects executable files anywhere under an added folder. */
function executablesUnder(dir: AbsolutePath): AbsolutePath[] {
  let names: string[];
  let subdirs: Set<string>;
  try {
    names = [...new Glob("*").scanSync({ ...SCAN_OPTIONS, cwd: dir })];
    subdirs = new Set(new Glob("*/").scanSync({ ...SCAN_OPTIONS, cwd: dir }));
  } catch {
    return [];
  }

  const found: AbsolutePath[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    if (subdirs.has(name)) found.push(...executablesUnder(path));
    else if (isExecutable(path)) found.push(path);
  }
  return found;
}

/** True for a non-directory entry with any execute bit set. */
function isExecutable(path: AbsolutePath): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isDirectory() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** True when the entry exists and is a directory. */
function isDirectory(path: AbsolutePath): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
