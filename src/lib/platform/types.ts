import type { AbsolutePath, Privilege } from "../../types";

/** Operating-system identifier used by records, artifacts, and platform lookup. */
export type PlatformId = "darwin" | "linux";

/** CPU architecture used in release artifact names. */
export type CpuArch = "arm64" | "x64";

/** One shell config file (or directory) an uninstall may clean. */
export type ShellConfigEntry = {
  /** Shell that reads this file. */
  shell: "zsh" | "bash" | "sh" | "fish";
  /** Whether `path` is relative to `$HOME` or absolute. */
  scope: "home" | "absolute";
  /** Home-relative path (when `scope` is "home") or an absolute path (scope "absolute"). */
  path: AbsolutePath;
  /** Files are edited in place; directories hold per-shell snippets handled by later phases. */
  kind: "file" | "directory";
};

/** Privilege policy for one platform (D8): support privileged installs, never escalate silently. */
export type PrivilegePolicy = {
  /** Whether installs that escalate to root are supported at all. */
  support: "supported" | "refused";
  /** Privilege of a normal install run started by the user. */
  defaultPrivilege: Privilege;
  /** Whether uninstall must consider sudo for entries owned by root. */
  sudoAwareUninstall: boolean;
  /** Tret never runs sudo on the user's behalf; the user escalates explicitly. */
  neverEscalate: boolean;
};

/** Release artifact naming and integrity tooling for one platform (D9). */
export type ArtifactNaming = {
  /** Executable name installed by the archive. */
  binary: string;
  /** Archive filename for one architecture, e.g. `tret-darwin-arm64.tar.gz`. */
  archiveName: (arch: CpuArch) => string;
  /** Checksum manifest published alongside the archives. */
  checksumFile: string;
  /** Shell command that prints a file's SHA-256 (`shasum -a 256` or `sha256sum`). */
  hashCommand: string;
};

/**
 * Filesystem case behavior for one platform (D10). The platform provides a default; the real
 * answer is probed per mount at install time and stored on the record. `detect` returns
 * "unknown" when a probe cannot run, so callers fall back to `defaultCaseSensitive`.
 */
export type CaseBehavior = {
  /** Value assumed when a mount cannot be probed (the last-resort default). */
  defaultCaseSensitive: boolean;
  /** Probes the mount containing `path`; Phase 2 is a stub returning the platform default. */
  detect: (path: AbsolutePath) => "sensitive" | "insensitive" | "unknown";
};

/**
 * Every OS-specific decision behind one seam (plan section 8). The core reads paths, guards,
 * shell configs, privilege, artifact naming, and case behavior from here so adding a platform is
 * one table plus one capture backend, not edits scattered across commands.
 */
export interface Platform {
  id: PlatformId;
  /** Human-readable label for logs and docs. */
  label: string;
  /** Absolute roots outside `$HOME` included in a scoped capture/snapshot (the old `SNAPSHOT_ROOTS`). */
  scopeRoots: AbsolutePath[];
  /**
   * Whether a scoped capture also observes `$HOME` itself, bounded by the shared skip rules
   * (`EXCLUDED_PATHS`, `EXCLUDED_DIR_NAMES`, `EXCLUDED_DIR_NAME_PATTERN`). macOS sets this so an
   * installer's top-level dotfiles/dot-directories (`~/.claude.json`, `~/.claude/`) are captured;
   * Linux keeps its narrower XDG scope and leaves it unset.
   */
  captureHomeRoot?: boolean;
  /** Home-relative tool directories searched by `tret find` (the old `SEARCH_DIRS_IN_HOME`). */
  searchRootsInHome: AbsolutePath[];
  /**
   * Home-relative roots a scoped capture observes (D3). Kept separate from `searchRootsInHome`:
   * `tret find` searches broadly to adopt a tool's files, while capture observes only install
   * surfaces and drops roots that churn without an installer (see the macOS table).
   */
  captureRootsInHome: AbsolutePath[];
  /** Absolute directories searched by `tret find` (the old `SNAPSHOT_ROOTS`). */
  searchRootsAbsolute: AbsolutePath[];
  /** Absolute directories uninstall refuses to delete whole (the old `SHARED_ABSOLUTE`). */
  sharedAbsolute: AbsolutePath[];
  /** Home-relative directories uninstall refuses to delete whole (the old `SHARED_IN_HOME`). */
  sharedInHome: AbsolutePath[];
  /** Shell config files uninstall cleans (the old `RC_FILES`), now per-OS and per-shell. */
  shellConfigs: ShellConfigEntry[];
  /** Privilege policy (D8). */
  privilege: PrivilegePolicy;
  /** Release artifact naming (D9). */
  artifacts: ArtifactNaming;
  /** Default filesystem case behavior (D10). */
  case: CaseBehavior;
}
