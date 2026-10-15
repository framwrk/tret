import { basename, dirname, join } from "node:path";
import type { AbsolutePath } from "../../types";
import type { CaseDetection } from "./types";
import { lstatSync } from "node:fs";

/** dev/ino identity of one path: the two numbers that tell whether two spellings name one file. */
export type PathIdentity = { dev: number; ino: number };

/** Reads a path's identity without following symlinks; undefined when it is absent or unreadable. */
export function lstatIdentity(path: string): PathIdentity | undefined {
  try {
    const stats = lstatSync(path);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

/**
 * Detects the case behavior of the filesystem holding `path` (D10) with reads only, never writes: it
 * stats the deepest existing ancestor segment that contains an ASCII letter together with the same
 * name with that letter's case flipped. The flipped name resolving to the very same file proves the
 * two spellings are one name (case-insensitive); a flipped name that is missing, or that resolves to
 * a different file, proves the filesystem keeps the spellings apart (case-sensitive). A name without
 * ASCII letters says nothing about case, and a path whose ancestors do not exist walks up to the
 * nearest existing one; when even the filesystem root has no probeable name the answer is `unknown`,
 * so callers fall back to the platform default.
 */
export function detectCaseBehavior(
  path: AbsolutePath,
  stat: (candidate: string) => PathIdentity | undefined = lstatIdentity,
): CaseDetection {
  let candidate: string = path;
  while (true) {
    const identity = stat(candidate);
    if (identity !== undefined) {
      const name = basename(candidate);
      const flipped = flipAsciiCase(name);
      if (flipped !== name) {
        const variant = stat(join(dirname(candidate), flipped));
        if (variant === undefined) return "sensitive";
        return variant.dev === identity.dev && variant.ino === identity.ino ? "insensitive" : "sensitive";
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return "unknown";
    candidate = parent;
  }
}

/**
 * Flips ASCII letter case and leaves everything else (digits, punctuation, non-ASCII letters)
 * untouched, so a probe never depends on Unicode case rules the filesystem may fold differently.
 */
export function flipAsciiCase(name: string): string {
  return name.replace(/[A-Za-z]/g, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
}
