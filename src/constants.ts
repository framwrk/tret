import type { GlobScanOptions } from "bun";

// Identity

/** Name Tret uses for itself in help output and prompts. */
export const SCRIPT_NAME = "Tret";

/**
 * Version printed by `--version`: the release tag injected into the compiled binary at build time
 * (`--define` in the build script), falling back to `dev` when running from source.
 */
export const VERSION = process.env.TRET_VERSION ?? "dev";

// Self-update

/**
 * Where `tret update` fetches its install script from: the same published script the public
 * install uses, so an update path never has to track the script it runs.
 */
export const UPDATE_SCRIPT_URL = "https://tret.framwrk.com/scripts/install.sh";

/** Where the daily update check caches its result, relative to `$HOME`. */
export const UPDATE_CHECK_PATH = ".tret/update-check.json";

/** The binary `tret update` replaces and the update check hashes, relative to `$HOME`. */
export const INSTALLED_BINARY = ".tret/bin/tret";

// Runtime mode

/**
 * True when running from source (`bun index.ts`), false when running as a compiled binary (`bun build --compile`).
 * A compiled executable runs its entry from Bun's virtual filesystem (`/$bunfs/...`); a dev run uses a real on-disk path.
 */
export const IS_DEV = !import.meta.path.startsWith("/$bunfs/");

// Records

/** Format number for the records file; bump when the record shape changes. */
export const RECORDS_VERSION = 2;

/** Where Tret stores its records, relative to `$HOME`. */
export const RECORDS_PATH = ".tret/records.json";

/**
 * Where Tret stores content-addressed before-image blobs, relative to `$HOME`. Blob files are named
 * by the sha256 of their content; nothing else lives in this directory.
 */
export const OBJECTS_PATH = ".tret/objects";

// Snapshot walk

/**
 * How each directory is scanned: record files and folders, don't follow symlinks, include dot-prefixed entries.
 * The extra roots walked alongside `$HOME` now live in the platform seam (`scopeRoots` in `src/lib/platform`).
 */
export const SCAN_OPTIONS: GlobScanOptions = { onlyFiles: false, followSymlinks: false, dot: true };

// Skip rules
// Skipped entries are neither recorded nor descended, so mtime churn inside them can't register as an edit.

/**
 * Home-relative paths to skip: top-level folders under `$HOME` or deeper paths (a folder like `.hermes/state`
 * or a single file like `.hermes/state.db-wal`). Edit this list to change what Tret ignores.
 */
export const EXCLUDED_PATHS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  ".Trash",
  ".hermes/state",
  ".hermes/cron",
  ".hermes/state.db-wal",
];

/**
 * Folder names to skip at any depth. Folders only, so a file named `build` stays tracked.
 * `venv` and `.venv` are deliberately absent: an installer can create one as its install target, and a missed before-image is unrecoverable.
 */
export const EXCLUDED_DIR_NAMES = new Set([
  "__pycache__",
  ".eggs",
  ".git",
  ".gradle",
  ".hg",
  ".ipynb_checkpoints",
  ".ivy2",
  ".m2",
  ".mypy_cache",
  ".next",
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
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

/**
 * Folder names that contain this pattern are skipped at any depth, alongside `EXCLUDED_DIR_NAMES`. Package-manager
 * caches (`~/.npm/_cacache`, `~/.cache`, `~/.bun/install/cache`) are shared by every installer, so no tool owns them.
 */
export const EXCLUDED_DIR_NAME_PATTERN = /cache/i;
