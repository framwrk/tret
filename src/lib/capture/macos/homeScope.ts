import { EXCLUDED_DIR_NAMES, EXCLUDED_DIR_NAME_PATTERN, EXCLUDED_PATHS } from "../../../constants";
import type { AbsolutePath } from "../../../types";
import type { ScopedRootBounds } from "./scoped";

/**
 * The pruning rules for the macOS `$HOME` root (defect #3). Adding `$HOME` restores the pre-rewrite
 * snapshot's top-level coverage — installers drop dotfiles/dot-directories like `~/.claude.json` and
 * `~/.claude/` directly at home — without turning the root into a global scan. It reuses the shared
 * skip rules exactly as the legacy `snapshotDir(home, …)` did: `EXCLUDED_PATHS` as absolute paths
 * (`~/Library`, `~/Desktop`, `~/Documents`, `~/Downloads`, `.hermes/state`, …) and
 * `EXCLUDED_DIR_NAMES`/`EXCLUDED_DIR_NAME_PATTERN` at any depth (`node_modules`, `*.git`, `cache`…).
 *
 * Because `EXCLUDED_PATHS` skips `Library`, the home walk never descends into `~/Library`, so the
 * explicit `~/Library/*` roots remain the only `~/Library` access and nothing is scanned twice.
 */
export function macosHomeRootBounds(home: AbsolutePath): ScopedRootBounds {
  return {
    excludePaths: new Set(EXCLUDED_PATHS.map((relative) => `${home}/${relative}`)),
    excludeDirNames: EXCLUDED_DIR_NAMES,
    excludeDirNamePattern: EXCLUDED_DIR_NAME_PATTERN,
  };
}
