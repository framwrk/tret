import type { AbsolutePath } from "../types";
import { lstatSync } from "node:fs";
import { scanDir } from "./scan";

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
  const scan = scanDir(dir);
  if (!scan) return [];

  const found: AbsolutePath[] = [];
  for (const name of scan.names) {
    const path = `${dir}/${name}`;
    if (scan.subdirs.has(name)) found.push(...executablesUnder(path));
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
