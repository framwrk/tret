import type { Platform, ShellConfigEntry } from "./platform";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AbsolutePath, RecordV3 } from "../types";
import { currentPlatform } from "./platform";
import { inspectPath } from "./uninstall-planner";
import { join } from "node:path";

export type RcCleaning = {
  cleaned: { file: AbsolutePath; line: string }[];
  failed: AbsolutePath[];
};

/** The shell-config work a removal may do, kept separate from the file plan. */
export type ShellCleanup = {
  /** Owned paths whose mention in a config line the install is allowed to strip. */
  dirs: AbsolutePath[];
  /** Attributed config files with no before-image, still matching their installed state, safe to line-clean. */
  files: AbsolutePath[];
};

/**
 * Selects the attributed shell-config mutations the narrow line cleaner should handle: those with
 * no before-image (a before-image is restored by the planner like any other mutation) and whose
 * bytes still match the recorded installed state. A config edited after install is left to the
 * planner, which reports it as a conflict rather than risking a user's later edit. Shared by
 * uninstall and the forced-reinstall path so both clean only files the install actually recorded.
 */
export function planShellCleanup(record: RecordV3, shellPaths: Set<AbsolutePath>): ShellCleanup {
  const dirs = record.owned.map((entry) => entry.path);
  const files: AbsolutePath[] = [];

  for (const entry of record.mutated) {
    if (!shellPaths.has(entry.path)) continue;
    if (entry.beforeBlob !== undefined) continue;
    if (entry.installedHash !== undefined) {
      const verification = inspectPath(entry.path);
      if (verification.exists && verification.hash !== undefined && verification.hash !== entry.installedHash) {
        continue;
      }
    }
    files.push(entry.path);
  }

  return { dirs, files };
}

/**
 * Absolute paths of the shell config files the active platform may clean. A file entry is the file
 * itself; a directory entry (for example `/etc/profile.d` on Linux) expands to the snippet files
 * directly inside it, so the directory is never read or written as a file.
 */
export function shellConfigPaths(platform: Platform = currentPlatform()): AbsolutePath[] {
  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");
  const files: AbsolutePath[] = [];
  for (const config of platform.shellConfigs) {
    for (const file of configFiles(config, home)) files.push(file);
  }
  return files;
}

/** The files one shell config entry covers. */
function configFiles(config: ShellConfigEntry, home: AbsolutePath): AbsolutePath[] {
  const path = config.scope === "home" ? join(home, config.path) : config.path;
  if (config.kind === "file") return [path];
  return snippetFiles(path);
}

/** Regular files directly inside a snippet directory; subdirectories and symlinks are left alone. */
function snippetFiles(dir: AbsolutePath): AbsolutePath[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * Removes shell config lines that reference the tool's own install dirs, plus a comment line
 * directly above one that names the tool. Only dirs recorded in `added[]` are matched, so a
 * shared PATH entry like `~/.local/bin` is never touched. When `only` is given, only those config
 * files are edited, which keeps cleanup tied to the edits attributed to the install. With
 * `dryRun` nothing is written.
 */
export function removeRcLines(
  name: string,
  dirs: AbsolutePath[],
  dryRun: boolean,
  only?: AbsolutePath[],
  platform: Platform = currentPlatform(),
): RcCleaning {
  const cleaned: RcCleaning["cleaned"] = [];
  const failed: AbsolutePath[] = [];
  const wanted = only === undefined ? undefined : new Set(only);

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  // With no attributed file there is nothing to select, so do not even enumerate shared snippet
  // directories such as `/etc/profile.d` (a forced reinstall may own a directory but no shell file).
  if (wanted !== undefined && wanted.size === 0) return { cleaned, failed };

  for (const config of platform.shellConfigs) {
    for (const file of configFiles(config, home)) {
      if (wanted !== undefined && !wanted.has(file)) {
        continue;
      }
      if (!existsSync(file)) {
        continue;
      }
      cleanFile(file, name, dirs, home, dryRun, cleaned, failed);
    }
  }

  return { cleaned, failed };
}

/** Removes the attributed lines from one existing config file. */
function cleanFile(
  file: AbsolutePath,
  name: string,
  dirs: AbsolutePath[],
  home: AbsolutePath,
  dryRun: boolean,
  cleaned: RcCleaning["cleaned"],
  failed: AbsolutePath[],
): void {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    failed.push(file);
    return;
  }

  const kept: string[] = [];
  const fileCleaned: RcCleaning["cleaned"] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    if (!mentionsDir(line, dirs, home)) {
      kept.push(line);
      continue;
    }

    fileCleaned.push({ file, line });

    // The installer's comment naming the tool above the PATH line is only a label for it.
    const previous = lines[index - 1];
    if (
      previous !== undefined &&
      previous.trim().startsWith("#") &&
      previous.toLowerCase().includes(name.toLowerCase()) &&
      kept[kept.length - 1] === previous
    ) {
      kept.pop();
      fileCleaned.push({ file, line: previous });
    }
  }

  if (kept.length === lines.length) {
    return;
  }

  if (dryRun) {
    cleaned.push(...fileCleaned);
    return;
  }

  try {
    writeFileSync(file, kept.join("\n"));
  } catch {
    // Nothing was removed, so a failed write must not surface as a cleaned line.
    failed.push(file);
    return;
  }

  cleaned.push(...fileCleaned);
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
