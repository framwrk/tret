import type { AbsolutePath } from "../../types";
import { EXCLUDED_DIR_NAME_PATTERN } from "../../constants";
import type { Platform } from "./types";

/** Options for expanding a platform table into bounded observation roots (D3). */
export type ObservationRootsOptions = {
  /** Home directory to expand home-relative roots against; defaults to `$HOME`. */
  home?: string;
  /** Extra absolute roots to add (user-configurable scope, D3). */
  include?: AbsolutePath[];
  /** Absolute roots to drop from the defaults (user-configurable scope, D3). */
  exclude?: AbsolutePath[];
};

/**
 * Expands a platform table into the bounded absolute roots a capture session observes (D3). This is
 * the table's absolute `scopeRoots` plus its home-relative `searchRootsInHome` and shell config files,
 * with optional user additions/removals. Roots are sorted and de-duplicated so a journal is
 * deterministic. The table is the bound: there is no other exclusion list here.
 */
export function observationRoots(platform: Platform, options: ObservationRootsOptions = {}): AbsolutePath[] {
  const home = options.home ?? Bun.env.HOME;
  const roots = new Set<AbsolutePath>();

  for (const root of platform.scopeRoots) roots.add(root);
  for (const config of platform.shellConfigs) {
    if (config.scope === "absolute") roots.add(config.path);
    else if (home) roots.add(`${home}/${config.path}`);
  }
  if (home) for (const relative of platform.searchRootsInHome) roots.add(`${home}/${relative}`);
  for (const path of options.include ?? []) roots.add(path);
  for (const path of options.exclude ?? []) roots.delete(path);

  return [...roots].sort();
}

/**
 * Observation roots for an install window. Shared package-manager caches are dropped: no installer
 * owns them and scanning them twice per install is pure churn, matching the legacy
 * `EXCLUDED_DIR_NAME_PATTERN` skip. Everything else in the D3 scope is kept.
 */
export function installObservationRoots(platform: Platform, options: ObservationRootsOptions = {}): AbsolutePath[] {
  return observationRoots(platform, options).filter((root) => !root.split("/").some(isCacheSegment));
}

function isCacheSegment(segment: string): boolean {
  return segment.length > 0 && EXCLUDED_DIR_NAME_PATTERN.test(segment);
}
