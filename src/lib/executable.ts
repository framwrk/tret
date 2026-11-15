import type { AbsolutePath } from "../types";
import { statSync } from "node:fs";

/** Resolves a command name to its path on PATH, or undefined when no such command exists. */
export function resolveCommand(name: string): AbsolutePath | undefined {
  return Bun.which(name) ?? undefined;
}

/** Picks the most likely installed binary among the changes: something in a bin folder first, then any executable. */
export function pickExecutable(added: AbsolutePath[]): AbsolutePath | undefined {
  const candidates = added.filter(isExecutable);
  const rank = (path: AbsolutePath): number => (path.split("/").at(-2) === "bin" ? 0 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0];
}

/** True for a regular file (or a symlink to one) with any execute bit set. */
function isExecutable(path: AbsolutePath): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
