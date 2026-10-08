import type { AbsolutePath } from "../types";
import { Glob } from "bun";
import { SCAN_OPTIONS } from "../constants";

export interface DirScan {
  names: string[];
  subdirs: Set<string>;
}

/** Lists a directory's entry names and subdirectory names; undefined when the directory cannot be read. */
export function scanDir(dir: AbsolutePath): DirScan | undefined {
  try {
    return {
      names: [...new Glob("*").scanSync({ ...SCAN_OPTIONS, cwd: dir })],
      subdirs: new Set(new Glob("*/").scanSync({ ...SCAN_OPTIONS, cwd: dir })),
    };
  } catch {
    return undefined;
  }
}
