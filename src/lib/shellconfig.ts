import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AbsolutePath } from "../types";
import { join } from "node:path";

// Shell config files Tret cleans on uninstall, relative to $HOME.
const RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"];

export type RcCleaning = {
  cleaned: { file: AbsolutePath; line: string }[];
  failed: AbsolutePath[];
};

/**
 * Removes shell config lines that reference the tool's own install dirs, plus a comment line
 * directly above one that names the tool. Only dirs recorded in `added[]` are matched, so a
 * shared PATH entry like `~/.local/bin` is never touched. With `dryRun` nothing is written.
 */
export function removeRcLines(name: string, dirs: AbsolutePath[], dryRun: boolean): RcCleaning {
  const cleaned: RcCleaning["cleaned"] = [];
  const failed: AbsolutePath[] = [];

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  for (const rc of RC_FILES) {
    const file = join(home, rc);
    if (!existsSync(file)) {
      continue;
    }

    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      failed.push(file);
      continue;
    }

    const kept: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }

      if (!dirs.some((dir) => line.includes(dir))) {
        kept.push(line);
        continue;
      }

      cleaned.push({ file, line });

      // The installer's comment naming the tool above the PATH line is only a label for it.
      const previous = lines[index - 1];
      if (
        previous !== undefined &&
        previous.trim().startsWith("#") &&
        previous.toLowerCase().includes(name.toLowerCase()) &&
        kept[kept.length - 1] === previous
      ) {
        kept.pop();
        cleaned.push({ file, line: previous });
      }
    }

    if (kept.length === lines.length) {
      continue;
    }

    if (dryRun) {
      continue;
    }

    try {
      writeFileSync(file, kept.join("\n"));
    } catch {
      failed.push(file);
    }
  }

  return { cleaned, failed };
}
