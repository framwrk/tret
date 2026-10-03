import type { AbsolutePath } from "./types";
import type { GlobScanOptions } from "bun";

// Identity

/** Name Tret uses for itself in help output and prompts. */
export const SCRIPT_NAME = "Tret";

// Runtime mode

/**
 * True when running from source (`bun index.ts`), false when running as a compiled binary (`bun build --compile`).
 * A compiled executable runs its entry from Bun's virtual filesystem (`/$bunfs/...`); a dev run uses a real on-disk path.
 */
export const IS_DEV = !import.meta.path.startsWith("/$bunfs/");

// Snapshot walk

/**
 * Extra roots to walk alongside `$HOME` when taking a snapshot.
 * `snapshot()` resolves `$HOME` itself and throws if the variable is unset, so it is not listed here.
 */
export const SNAPSHOT_ROOTS: AbsolutePath[] = ["/opt/homebrew/bin", "/usr/local/bin"];

/** How each directory is scanned: record files and folders, don't follow symlinks, include dot-prefixed entries. */
export const SCAN_OPTIONS: GlobScanOptions = { onlyFiles: false, followSymlinks: false, dot: true };

// Skip rules
// Skipped entries are neither recorded nor descended, so mtime churn inside them can't register as an edit.

/**
 * Top-level folder names under `$HOME` to skip. Applied to the home root only; edit this list to change what Tret ignores.
 */
export const EXCLUDED_DIRS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",

  ".Trash",

  ".hermes",
  ".codex",
  ".bun/install",
];

/**
 * Folder names to skip at any depth. Folders only, so a file named `build` stays tracked.
 * `venv` and `.venv` are deliberately absent: an installer can create one as its install target, and a missed before-image is unrecoverable.
 */
export const EXCLUDED_DIR_NAMES = new Set([
  "__pycache__",
  ".cache",
  ".eggs",
  ".git",
  ".gradle",
  ".hg",
  ".ipynb_checkpoints",
  ".ivy2",
  ".m2",
  ".mypy_cache",
  ".next",
  ".npm",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".sbt",
  ".svelte-kit",
  ".svn",
  ".terraform",
  ".tox",
  ".turbo",
  ".vite",
  ".zcompcache",
  "build",
  "cache",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
