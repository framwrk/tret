import type { Platform, ShellConfigEntry } from "./platform";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AbsolutePath } from "../types";
import { currentPlatform } from "./platform";
import { join } from "node:path";

export type RcCleaning = {
  cleaned: { file: AbsolutePath; line: string }[];
  failed: AbsolutePath[];
};

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
 * Removes shell config lines that reference the tool's own install dirs, plus a marked line that
 * adds a shared directory such as `~/.local/bin` to PATH. A shared line is only touched when the
 * caller supplies the file as attributed (`only`), the file still matches its recorded installed
 * hash, and the line itself or the comment directly above it names the tool. Without that
 * evidence an unmarked shared PATH entry is never removed. With `dryRun` nothing is written.
 */
export function removeRcLines(
  name: string,
  dirs: AbsolutePath[],
  dryRun: boolean,
  only?: AbsolutePath[],
  platform: Platform = currentPlatform(),
  installedHashes?: ReadonlyMap<AbsolutePath, string>,
): RcCleaning {
  const cleaned: RcCleaning["cleaned"] = [];
  const failed: AbsolutePath[] = [];
  const wanted = only === undefined ? undefined : new Set(only);

  const home = Bun.env.HOME;
  if (!home) throw new Error("HOME is not set");

  const shared = sharedDirs(platform, home);

  for (const config of platform.shellConfigs) {
    for (const file of configFiles(config, home)) {
      if (wanted !== undefined && !wanted.has(file)) {
        continue;
      }
      if (!existsSync(file)) {
        continue;
      }
      const attributed = wanted !== undefined;
      const installedHash = installedHashes?.get(file);
      cleanFile(file, name, dirs, shared, home, attributed, installedHash, dryRun, cleaned, failed);
    }
  }

  return { cleaned, failed };
}

/** Removes the attributed lines from one existing config file. */
function cleanFile(
  file: AbsolutePath,
  name: string,
  dirs: AbsolutePath[],
  shared: AbsolutePath[],
  home: AbsolutePath,
  attributed: boolean,
  installedHash: string | undefined,
  dryRun: boolean,
  cleaned: RcCleaning["cleaned"],
  failed: AbsolutePath[],
): void {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch {
    failed.push(file);
    return;
  }

  const lines = Buffer.from(bytes).toString("utf8").split("\n");
  // Without the recorded installed hash there is no before-image to prove the line is ours, so a
  // shared PATH entry stays detect-only even when the file is attributed.
  const sharedAllowed = attributed && installedHash !== undefined && sha256Hex(bytes) === installedHash;
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    const previous = lines[index - 1];
    const adjacentToolComment =
      previous !== undefined &&
      previous.trim().startsWith("#") &&
      previous.toLowerCase().includes(name.toLowerCase()) &&
      kept[kept.length - 1] === previous;
    const owned = mentionsDir(line, dirs, home);
    const marked = inlineCommentNamesTool(line, name) || adjacentToolComment;
    const sharedLine = sharedAllowed && mentionsSharedDir(line, shared, home) && marked;

    if (!owned && !sharedLine) {
      kept.push(line);
      continue;
    }

    cleaned.push({ file, line });

    // The installer's comment naming the tool above the PATH line is only a label for it.
    if (adjacentToolComment && previous !== undefined) {
      kept.pop();
      cleaned.push({ file, line: previous });
    }
  }

  if (kept.length === lines.length) {
    return;
  }

  if (dryRun) {
    return;
  }

  try {
    writeFileSync(file, kept.join("\n"));
  } catch {
    failed.push(file);
  }
}

/** The platform's shared directories, as absolute paths, for the marked-line exception. */
function sharedDirs(platform: Platform, home: AbsolutePath): AbsolutePath[] {
  return [...platform.sharedInHome.map((path) => join(home, path)), ...platform.sharedAbsolute];
}

/**
 * True when the line names one of the dirs, written expanded, as `$HOME/...`, `${HOME}/...`, or `~/...`.
 * A match must start and end at a path boundary, so `/x/.mytool` does not match `/a/x/.mytool` or
 * `/x/.mytool-tools`.
 */
function mentionsDir(line: string, dirs: AbsolutePath[], home: AbsolutePath): boolean {
  return dirs.some((dir) =>
    formsOf(dir, home).some((form) => new RegExp(`(?:^|[^\\w./-])${escapeRegex(form)}(?![\\w.-])`).test(line)),
  );
}

/**
 * True when the line names exactly a shared dir. A subdirectory such as `~/.local/bin/other` is a
 * different entry and must not be mistaken for the shared dir itself.
 */
function mentionsSharedDir(line: string, dirs: AbsolutePath[], home: AbsolutePath): boolean {
  return dirs.some((dir) =>
    formsOf(dir, home).some((form) => new RegExp(`(?:^|[^\\w./-])${escapeRegex(form)}(?![\\w./-])`).test(line)),
  );
}

/** The forms a dir can appear as in a shell config: expanded, `$HOME`, `${HOME}`, and `~`. */
function formsOf(dir: AbsolutePath, home: AbsolutePath): string[] {
  const forms = [dir];
  if (dir.startsWith(`${home}/`)) {
    const rest = dir.slice(home.length);
    forms.push(`$HOME${rest}`, `\${HOME}${rest}`, `~${rest}`);
  }
  return forms;
}

/** True when an inline comment on the line names the tool, such as `... # mytool`. */
function inlineCommentNamesTool(line: string, name: string): boolean {
  const comment = line.indexOf("#");
  if (comment === -1) return false;
  return line.slice(comment + 1).toLowerCase().includes(name.toLowerCase());
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
