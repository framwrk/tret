import type { AbsolutePath } from "../../../types";
import { MACOS_PLATFORM } from "../../platform";
import type { ObservationRootsOptions } from "../../platform/roots";
import type { Platform } from "../../platform";
import { observationRoots } from "../../platform/roots";

/** Options for expanding a platform table into bounded observation roots (D3). */
export type MacosScopeOptions = ObservationRootsOptions;

/**
 * Expands a platform table into the bounded absolute roots the macOS heuristic backend observes. On
 * macOS this is the table's absolute `scopeRoots` plus its home-relative `captureRootsInHome` and home
 * shell config files (the plan's fallback scope, D3). The capture roots are curated separately from
 * `tret find`'s search roots so volatile `~/Library` subtrees are not scanned: see the macOS table and
 * `docs/rewrite/macos-capture.md`. There is no other exclusion list here: the table is the bound, and
 * it is revisited with fixtures rather than padded with skips. Roots are sorted and de-duplicated so a
 * journal is deterministic.
 */
export function macosHeuristicRoots(options: MacosScopeOptions = {}, platform: Platform = MACOS_PLATFORM): AbsolutePath[] {
  return observationRoots(platform, options);
}

/**
 * Database sidecars and journals that background daemons rewrite continuously, independently of any
 * installer: SQLite WAL/shm files (`main.db-wal`, `sqlite-shm`) and `*-journal` files. Matched on the
 * basename only, so it never needs an app-specific path.
 */
const SIDECAR_PATTERN = /(?:^|[.-])(?:db|sqlite)-(?:wal|shm)$|-journal$/i;

/**
 * Whether a path is a known churn shape to skip while scanning. The root-level trim already drops
 * `~/Library` subtrees that only churn; this small, shape-based rule covers the volatile files that
 * remain inside a kept root (`Library/Application Support`), so they cannot be attributed to an
 * install. It is intentionally not a per-app exclusion list: browser/Electron/IndexedDB state is
 * matched structurally, and a single rule covers every app.
 */
export function isVolatileChurnPath(path: AbsolutePath): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (SIDECAR_PATTERN.test(base)) return true;
  // LevelDB write-ahead logs live under `IndexedDB` and rotate on every state change.
  return /\.log$/i.test(base) && path.includes("/IndexedDB/");
}
