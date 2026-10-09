import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AbsolutePath } from "../types";
import { MACOS_PLATFORM } from "./platform";
import { join } from "node:path";

export type RcCleaning = {
  cleaned: { file: AbsolutePath; line: string }[];
  failed: AbsolutePath[];
};

/** Absolute paths of the shell config files the active platform may clean; directories are excluded. */
export function shellConfigPaths(platform = MACOS_PLATFORM): AbsolutePath[] {
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");
  return platform.shellConfigs
    .filter((config) => config.kind === "file")
    .map((config) => (config.scope === "home" ? join(home, config.path) : config.path));
}

/**
 * Removes shell config lines that reference the tool's own install dirs, plus a comment line
 * directly above one that names the tool. Only dirs recorded in `added[]` are matched, so a
 * shared PATH entry like `~/.local/bin` is never touched. When `only` is given, only those config
 * files are edited, which keeps cleanup tied to the edits attributed to the install. With
 * `dryRun` nothing is written.
 */
export function removeRcLines(name: string, dirs: AbsolutePath[], dryRun: boolean, only?: AbsolutePath[]): RcCleaning {
  const cleaned: RcCleaning["cleaned"] = [];
  const failed: AbsolutePath[] = [];
  const wanted = only === undefined ? undefined : new Set(only);

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  for (const config of MACOS_PLATFORM.shellConfigs) {
    // Directory entries (for example `/etc/profile.d`) are handled by a later phase.
    if (config.kind !== "file") {
      continue;
    }
    const file = config.scope === "home" ? join(home, config.path) : config.path;
    if (wanted !== undefined && !wanted.has(file)) {
      continue;
    }
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

      if (!mentionsDir(line, dirs, home)) {
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

/**
 * True when the line names one of the dirs, written expanded, as `$HOME/...`, `${HOME}/...`, or `~/...`.
 * A match must end at a path boundary, so `/x/.mytool` does not match a line that names `/x/.mytool-tools`.
 */
function mentionsDir(line: string, dirs: AbsolutePath[], home: AbsolutePath): boolean {
  return dirs.some((dir) => {
    const forms = [dir];
    if (dir.startsWith(`${home}/`)) {
      const rest = dir.slice(home.length);
      forms.push(`$HOME${rest}`, `\${HOME}${rest}`, `~${rest}`);
    }
    return forms.some((form) => new RegExp(`${escapeRegex(form)}(?![\\w.-])`).test(line));
  });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
