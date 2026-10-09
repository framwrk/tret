import type { AbsolutePath, ManagedPackage, OwnedEntry, PackageManagerId } from "../types";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, lstatSync, readlinkSync } from "node:fs";

// Package-manager global mode. A global install lives in shared state every other global install
// also edits: one `node_modules` (plus, for bun, a lockfile and manifest). Tret never records those
// paths as owned — bun's global root is skipped at capture time, and npm's shared tree is filtered
// out once the shim identifies the package — so uninstall delegates to the manager's own remove
// command. Detection leans on the bin shim a global install leaves behind: it is a symlink into the
// manager's shared `node_modules`, and the package name is the first path segment(s) below it.
//
// bun keeps its globals at one fixed home-relative root. npm does not: its prefix is whatever
// `npm config get prefix` reports, so the shim target is what reveals the root to remove from.

/** How one manager keeps its globals home-relative, plus the remove command for a package. */
type ManagerSpec = {
  /** Home-relative shared root the global state lives under (contains the shared `node_modules`). */
  globalRoot: string;
  /** Arguments passed to the manager binary to remove a global package, given its resolved root. */
  remove: (pkg: string, globalRoot: AbsolutePath) => string[];
};

const MANAGERS: Partial<Record<PackageManagerId, ManagerSpec>> = {
  bun: {
    globalRoot: ".bun/install/global",
    remove: (pkg) => ["remove", "-g", pkg],
  },
  npm: {
    // `~/.npm-global` is the conventional home prefix, but npm actually uses whatever
    // `npm config get prefix` reports (`~/.local`, `/opt/homebrew`, an nvm tree...). Detection
    // records the real root on the package; this stays only as the fallback for a record written
    // before that field existed.
    globalRoot: ".npm-global/lib",
    // The shared root is `<prefix>/lib`, so npm removes from the prefix one level up.
    remove: (pkg, globalRoot) => ["uninstall", "-g", "--prefix", dirname(globalRoot), pkg],
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
    const packageName = packageFromNodeModules(target, join(home, spec.globalRoot, "node_modules"));
    if (packageName !== undefined) return { manager, package: packageName };
  }

  // npm's fixed default above only matches `~/.npm-global`; resolve the machine's real prefix from
  // the shim so an install under `~/.local`, `/opt/homebrew`, or an nvm tree is still recognized.
  return detectNpmGlobal(executable, target);
}

/**
 * Recognizes an npm global from its shim target when npm's prefix is not the home-relative default.
 * A global package keeps its files under `<prefix>/lib/node_modules/<package>` and its shim in
 * `<prefix>/bin`; the prefix is recorded so removal runs `npm uninstall -g --prefix <prefix>` and
 * never touches a different prefix's package of the same name. A target that merely mentions
 * `lib/node_modules` somewhere else (or whose shim sits outside the prefix) is not a global install.
 */
function detectNpmGlobal(executable: AbsolutePath, target: AbsolutePath): ManagedPackage | undefined {
  const marker = "/lib/node_modules/";
  const index = target.lastIndexOf(marker);
  if (index <= 0) return undefined;

  const prefix = target.slice(0, index);
  if (dirname(executable) !== join(prefix, "bin")) return undefined;

  const packageName = packageFromNodeModules(target, join(prefix, "lib", "node_modules"));
  if (packageName === undefined) return undefined;
  return { manager: "npm", package: packageName, globalRoot: join(prefix, "lib") };
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
 * The shared global root a managed package's state lives under, or undefined for an unsupported
 * manager. A record's own `globalRoot` (npm's machine-specific prefix) wins over the fixed default.
 * Tret never owns or removes anything at or under it.
 */
export function managedGlobalRoot(pkg: ManagedPackage, home: AbsolutePath): AbsolutePath | undefined {
  if (pkg.globalRoot !== undefined) return pkg.globalRoot;
  const spec = MANAGERS[pkg.manager];
  return spec === undefined ? undefined : join(home, spec.globalRoot);
}

/** True when `path` is shared package-manager state that belongs to no single tool. */
export function isManagedGlobalPath(path: AbsolutePath, pkg: ManagedPackage, home: AbsolutePath): boolean {
  const root = managedGlobalRoot(pkg, home);
  if (root === undefined) return false;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Keeps only the entries a record may own from a managed package: its shared global root (the
 * manifest, lockfile, and `node_modules` tree every global install rewrites) is dropped, while the
 * bin shim outside it survives. Without this the capture could attribute the shared tree — npm's
 * `lib/node_modules` is a capture root and is scanned whole — so a reinstall or uninstall would
 * delete state other packages share.
 */
export function withoutManagedGlobalPaths<T extends { path: AbsolutePath }>(
  entries: readonly T[],
  pkg: ManagedPackage,
  home: AbsolutePath | undefined,
): T[] {
  if (home === undefined) return [...entries];
  return entries.filter((entry) => !isManagedGlobalPath(entry.path, pkg, home));
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
  const root = managedGlobalRoot(pkg, home);
  if (spec === undefined || root === undefined) {
    return { ok: false, skipped: false, detail: `${pkg.manager} is not a supported package manager` };
  }

  const packageDir = join(root, "node_modules", pkg.package);
  if (!existsSync(packageDir)) return { ok: true, skipped: true, detail: `${pkg.package} is already absent` };

  const runner = options.runner ?? spawnRunner;
  let result: PackageCommandResult;
  try {
    result = await runner(pkg.manager, spec.remove(pkg.package, root));
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
