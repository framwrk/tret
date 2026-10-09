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
 * Runtime logs an app appends to while it runs, matched by shape rather than by app: a `.log`,
 * `.ndjson`, or `.trace` file directly under a `log`/`logs` directory. The two shapes seen in the
 * wild are `~/.local/share/opencode/log/opencode.log` and `~/.t3/userdata/logs/*.trace.ndjson`. No
 * installed payload lives under such a directory, so a concurrent append is churn, not installer
 * output.
 */
const RUNTIME_LOG_PATTERN = /(?:^|\/)(?:logs?)\/[^/]+\.(?:log|ndjson|trace)$/i;

/**
 * WebKit/Chromium storage trees a running app rewrites continuously, independent of any installer;
 * `Library/Application Support/<app>/WebStorage/QuotaManager` is the canonical example. Matched
 * structurally so one rule covers every app, because nothing installable lives inside them.
 * `IndexedDB` is handled narrowly below: a LevelDB store also holds stable files (`MANIFEST-*`,
 * `CURRENT`) that must stay tracked.
 */
const BROWSER_STORAGE_PATTERN = /\/WebStorage\//i;

/**
 * Whether a path is a known churn shape to skip while scanning. The root-level trim already drops
 * `~/Library` subtrees that only churn; these shape-based rules cover the volatile files that remain
 * inside a kept root (`Library/Application Support`, `.local`, `$HOME`), so they cannot be attributed
 * to an install. They are intentionally not a per-app exclusion list: sidecar, runtime-log, and
 * browser/IndexedDB state are matched structurally, and a single rule covers every app.
 */
export function isVolatileChurnPath(path: AbsolutePath): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (SIDECAR_PATTERN.test(base)) return true;
  if (RUNTIME_LOG_PATTERN.test(path)) return true;
  if (BROWSER_STORAGE_PATTERN.test(path)) return true;
  // LevelDB write-ahead logs live under `IndexedDB` and rotate on every state change.
  return /\.log$/i.test(base) && path.includes("/IndexedDB/");
}
