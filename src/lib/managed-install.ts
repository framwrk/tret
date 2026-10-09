import type { AbsolutePath, ManagedInstall, OwnedEntry } from "../types";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";

// Managed install. Some tools ship a first-party installer that lays out versioned releases under a
// managed root and marks the layout with a marker file, then drops a launcher and (optionally) a PATH
// symlink. The root's payload is a full `node_modules` tree, which capture deliberately skips
// everywhere (`EXCLUDED_DIR_NAMES`), so owning the root's directories would strand the record: after
// uninstall removes the tracked wrapper files, the untracked `node_modules` keeps every ancestor
// `not-empty`, the run conflicts, and the record is stuck. This parallels package-manager globals:
// recognize the layout from its marker, never own the payload, and delegate removal of the managed
// root before Tret removes the owned remainder.
//
// Detection leans on the launcher the installer leaves under `<agent>/bin/<cmd>`, with the managed
// root as its sibling `<agent>/install`. A PATH entrypoint symlink is resolved first, so a command
// reached through the symlink is recognized the same way the installer's own uninstaller resolves it.

/** One recognized managed-install layout: the marker that identifies it and where its root can be. */
type ManagedInstallLayout = {
  /** Marker `kind` that identifies the layout. */
  kind: string;
  /** Marker `schemaVersion` this build understands. */
  schemaVersion: number;
  /** Marker `layout` name. */
  layout: string;
  /** Marker filename at the managed root. */
  marker: string;
  /** Candidate roots to probe, given the fully symlink-resolved command path. */
  rootCandidates: (resolved: AbsolutePath) => AbsolutePath[];
};

const PI_MARKER = "managed-install.json";

/**
 * Known managed-install layouts. Today this is the Pi managed installer
 * (`kind: pi-managed-install`, `layout: releases-v1`); the registry shape is the same as the package
 * manager table, so another first-party layout is one entry, not a scattered edit.
 */
const LAYOUTS: ManagedInstallLayout[] = [
  {
    kind: "pi-managed-install",
    schemaVersion: 1,
    layout: "releases-v1",
    marker: PI_MARKER,
    rootCandidates: (resolved) => {
      const dir = dirname(resolved);
      const candidates = [dir];
      // The launcher lives in `<agent>/bin`, and the managed root is the sibling `<agent>/install`.
      if (basename(dir) === "bin") candidates.push(join(dirname(dir), "install"));
      return candidates;
    },
  },
];

/** The JSON marker's fields we read; other fields (`entrypoint`, …) are ignored. */
type Marker = { kind?: unknown; schemaVersion?: unknown; layout?: unknown };

/**
 * Detects whether `executable` is a first-party managed-install launcher and, if so, which layout
 * and root. The recorded owned entry supplies a symlink target when the record is available;
 * otherwise the file on disk is resolved. Returns undefined for a normal binary or an unrecognized
 * layout, so a missed detection degrades to ordinary file ownership rather than a wrong removal.
 */
export function detectManagedInstall(executable: AbsolutePath, owned: readonly OwnedEntry[] = []): ManagedInstall | undefined {
  if (executable === "") return undefined;
  const resolved = resolveCommandPath(executable, owned);
  for (const layout of LAYOUTS) {
    for (const candidate of layout.rootCandidates(resolved)) {
      if (markerMatches(candidate, layout)) {
        return { kind: layout.kind, layout: layout.layout, root: candidate };
      }
    }
  }
  return undefined;
}

/** True when `path` is the managed root or sits under it (the payload Tret never owns). */
export function isManagedInstallPath(path: AbsolutePath, managed: ManagedInstall): boolean {
  return path === managed.root || path.startsWith(`${managed.root}/`);
}

/**
 * Keeps only the entries a record may own from a managed install: the whole root subtree (the
 * marker, release payload, staging, and `current-version`) is dropped and left to the delegated
 * removal, while the launcher and PATH entrypoint outside it survive and are still removed by Tret.
 */
export function withoutManagedInstallPaths<T extends { path: AbsolutePath }>(
  entries: readonly T[],
  managed: ManagedInstall,
): T[] {
  return entries.filter((entry) => !isManagedInstallPath(entry.path, managed));
}

/** One delegated removal command invocation: exit code plus whatever the command wrote. */
export type ManagedInstallCommandResult = { code: number; stdout: string; stderr: string };

/** Runs one delegated removal command; injectable so removal is testable without spawning anything. */
export type ManagedInstallRunner = (command: string, args: string[]) => Promise<ManagedInstallCommandResult>;

/** The result of delegating a managed root's removal. */
export type ManagedInstallRemoval = {
  /** True when the root is gone (removed now or already absent). */
  ok: boolean;
  /** Whether nothing had to be done because the root was already absent. */
  skipped: boolean;
  /** Human-readable explanation for the outcome. */
  detail: string;
};

/**
 * Removes a managed root by delegating a recursive removal of the whole tree, which is safe only
 * because the marker still identifies it. The marker is re-verified immediately before deleting, so
 * a directory that was repurposed or whose marker vanished is never recursively removed; the caller
 * then keeps the record. A missing root is a no-op, and success is proven by the root being gone
 * afterwards rather than trusted from the exit code.
 *
 * Tret does not invoke the installed tool's own uninstall command: the record already owns the
 * launcher and entrypoint outside the root, and running an installed command is outside Tret's model.
 */
export async function removeManagedInstall(
  managed: ManagedInstall,
  options: { runner?: ManagedInstallRunner } = {},
): Promise<ManagedInstallRemoval> {
  if (!existsSync(managed.root)) {
    return { ok: true, skipped: true, detail: `${managed.root} is already absent` };
  }

  const layout = LAYOUTS.find((candidate) => candidate.kind === managed.kind && candidate.layout === managed.layout);
  if (layout === undefined) {
    return {
      ok: false,
      skipped: false,
      detail: `${managed.kind} (${managed.layout}) is not a supported managed-install layout`,
    };
  }
  if (!markerMatches(managed.root, layout)) {
    return {
      ok: false,
      skipped: false,
      detail: `marker ${join(managed.root, layout.marker)} is missing or no longer valid`,
    };
  }

  const runner = options.runner ?? spawnRunner;
  let result: ManagedInstallCommandResult;
  try {
    result = await runner("rm", ["-rf", managed.root]);
  } catch (error) {
    return { ok: false, skipped: false, detail: message(error) };
  }

  if (!existsSync(managed.root)) return { ok: true, skipped: false, detail: `removed ${managed.root}` };
  return {
    ok: false,
    skipped: false,
    detail: `rm exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
  };
}

/** The real runner: spawn `rm`, inherit the environment (and PATH), capture output. */
const spawnRunner: ManagedInstallRunner = async (command, args) => {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
};

/** A short label for a managed install, used in install/uninstall output. */
export function describeManagedInstall(managed: ManagedInstall): string {
  return `${managed.kind} at ${managed.root}`;
}

/** Whether a root's marker still matches a layout: kind, schemaVersion, and layout all agree. */
function markerMatches(root: AbsolutePath, layout: ManagedInstallLayout): boolean {
  const marker = readMarker(join(root, layout.marker));
  return marker?.kind === layout.kind && marker.schemaVersion === layout.schemaVersion && marker.layout === layout.layout;
}

/** Reads and parses a marker file; a missing, unreadable, or invalid marker is undefined. */
function readMarker(path: AbsolutePath): Marker | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Marker;
  } catch {
    return undefined;
  }
}

/**
 * The command's real path: the recorded symlink target when the record supplies one, then any
 * on-disk symlink chain (a PATH entrypoint pointing at the launcher), bounded to avoid a cycle.
 */
function resolveCommandPath(executable: AbsolutePath, owned: readonly OwnedEntry[]): AbsolutePath {
  const recorded = owned.find((entry) => entry.path === executable)?.linkTarget;
  let current = recorded === undefined ? executable : absolutize(dirname(executable), recorded);

  for (let hop = 0; hop < 40; hop++) {
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      current = absolutize(dirname(current), readlinkSync(current));
    } catch {
      break;
    }
  }
  return current;
}

/** Resolves a possibly-relative symlink target against the directory holding the link. */
function absolutize(base: AbsolutePath, target: AbsolutePath): AbsolutePath {
  return isAbsolute(target) ? target : resolve(base, target);
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
