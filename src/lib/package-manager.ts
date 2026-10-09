import type { AbsolutePath, ManagedPackage, OwnedEntry, PackageManagerId } from "../types";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, lstatSync, readlinkSync } from "node:fs";

// Package-manager global mode. A global install lives in shared state every other global install
// also edits: one `node_modules`, one lockfile, one manifest. Tret never owns those paths (they are
// skipped at capture time), so uninstall delegates to the manager's own remove command. Detection
// leans on the bin shim a global install leaves behind: it is a symlink into the manager's shared
// `node_modules`, and the package name is the first path segment(s) below `node_modules`.

/** How one manager keeps its globals home-relative, plus the remove command for a package. */
type ManagerSpec = {
  /** Home-relative shared `node_modules` root that global shims point into. */
  nodeModules: string;
  /** Home-relative shared root the global state lives under; never owned or removed by Tret. */
  globalRoot: string;
  /** Arguments passed to the manager binary to remove a global package. */
  remove: (pkg: string) => string[];
};

const MANAGERS: Partial<Record<PackageManagerId, ManagerSpec>> = {
  bun: {
    nodeModules: ".bun/install/global/node_modules",
    globalRoot: ".bun/install/global",
    remove: (pkg) => ["remove", "-g", pkg],
  },
  npm: {
    nodeModules: ".npm-global/lib/node_modules",
    globalRoot: ".npm-global",
    remove: (pkg) => ["uninstall", "-g", pkg],
  },
};

/**
 * Detects whether `executable` is a package-manager global shim and, if so, which package it runs.
 * The recorded owned entry supplies the symlink target when the record is available; otherwise the
 * executable on disk is inspected. Returns undefined for a normal binary or an unknown layout, so a
 * missed detection degrades to ordinary file ownership rather than a wrong removal.
 */
export function detectManagedPackage(
  executable: AbsolutePath,
  owned: readonly OwnedEntry[],
  home: AbsolutePath | undefined = Bun.env.HOME,
): ManagedPackage | undefined {
  if (!home || executable === "") return undefined;
  const target = symlinkTarget(executable, owned);
  if (target === undefined) return undefined;

  for (const [manager, spec] of Object.entries(MANAGERS) as [PackageManagerId, ManagerSpec][]) {
    const packageName = packageFromNodeModules(target, join(home, spec.nodeModules));
    if (packageName !== undefined) return { manager, package: packageName };
  }
  return undefined;
}

/** The absolute path a shim points at: the recorded symlink target when known, else the file on disk. */
function symlinkTarget(executable: AbsolutePath, owned: readonly OwnedEntry[]): AbsolutePath | undefined {
  const entry = owned.find((candidate) => candidate.path === executable);
  let raw = entry?.kind === "symlink" ? entry.linkTarget : undefined;

  if (raw === undefined) {
    try {
      if (lstatSync(executable).isSymbolicLink()) raw = readlinkSync(executable);
    } catch {
      return undefined;
    }
  }

  if (raw === undefined) return undefined;
  return isAbsolute(raw) ? raw : resolve(dirname(executable), raw);
}

/**
 * The shared global root a managed package's state lives under (e.g. `~/.bun/install/global`), or
 * undefined for an unsupported manager. Tret never owns or removes anything at or under it.
 */
export function managedGlobalRoot(pkg: ManagedPackage, home: AbsolutePath): AbsolutePath | undefined {
  const spec = MANAGERS[pkg.manager];
  return spec === undefined ? undefined : join(home, spec.globalRoot);
}

/** True when `path` is shared package-manager state that belongs to no single tool. */
export function isManagedGlobalPath(path: AbsolutePath, pkg: ManagedPackage, home: AbsolutePath): boolean {
  const root = managedGlobalRoot(pkg, home);
  if (root === undefined) return false;
  return path === root || path.startsWith(`${root}/`);
}

/** The package the path names below a `node_modules` root, handling a scoped `@scope/name`; undefined when outside it. */
function packageFromNodeModules(target: AbsolutePath, nodeModules: AbsolutePath): string | undefined {
  const prefix = `${nodeModules}/`;
  if (!target.startsWith(prefix)) return undefined;

  const segments = target.slice(prefix.length).split("/").filter(Boolean);
  const first = segments[0];
  if (first === undefined) return undefined;
  if (first.startsWith("@")) return segments[1] === undefined ? undefined : `${first}/${segments[1]}`;
  return first;
}

/** One captured package-manager invocation: exit code plus whatever the command wrote. */
export type PackageCommandResult = { code: number; stdout: string; stderr: string };

/** Runs one package-manager command; injectable so removal is testable without spawning anything. */
export type PackageCommandRunner = (command: string, args: string[]) => Promise<PackageCommandResult>;

/** The result of asking a package manager to remove a global package. */
export type PackageRemoval = {
  /** True when the package is gone (removed now or already absent). */
  ok: boolean;
  /** Whether the manager was not needed because the package was already absent. */
  skipped: boolean;
  /** Human-readable explanation for the outcome. */
  detail: string;
};

/**
 * Removes a global package through its manager. The package is proven gone rather than trusted: an
 * already-absent `node_modules` is a no-op, a zero exit is success, and a non-zero exit is success
 * only if the package directory is gone afterwards. Anything else stays actionable so the record is
 * kept for a retry.
 */
export async function removeManagedPackage(
  pkg: ManagedPackage,
  options: { home?: AbsolutePath; runner?: PackageCommandRunner } = {},
): Promise<PackageRemoval> {
  const home = options.home ?? Bun.env.HOME;
  if (!home) return { ok: false, skipped: false, detail: "HOME is not set" };

  const spec = MANAGERS[pkg.manager];
  if (spec === undefined) return { ok: false, skipped: false, detail: `${pkg.manager} is not a supported package manager` };

  const packageDir = join(home, spec.nodeModules, pkg.package);
  if (!existsSync(packageDir)) return { ok: true, skipped: true, detail: `${pkg.package} is already absent` };

  const runner = options.runner ?? spawnRunner;
  let result: PackageCommandResult;
  try {
    result = await runner(pkg.manager, spec.remove(pkg.package));
  } catch (error) {
    return { ok: false, skipped: false, detail: message(error) };
  }

  if (result.code === 0) return { ok: true, skipped: false, detail: `${pkg.manager} removed ${pkg.package}` };
  if (!existsSync(packageDir)) {
    return { ok: true, skipped: false, detail: `${pkg.manager} exited ${result.code} but ${pkg.package} is gone` };
  }
  return {
    ok: false,
    skipped: false,
    detail: `${pkg.manager} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
  };
}

/** The real runner: spawn the manager binary, inherit the environment (and PATH), capture output. */
const spawnRunner: PackageCommandRunner = async (command, args) => {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
};

/** A short label for a managed package, used in install/uninstall output. */
export function describeManagedPackage(pkg: ManagedPackage): string {
  return `${pkg.package} (${pkg.manager} global)`;
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
