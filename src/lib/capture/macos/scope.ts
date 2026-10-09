import type { AbsolutePath } from "../../../types";
import { MACOS_PLATFORM } from "../../platform";
import type { Platform } from "../../platform";

/** Options for expanding a platform table into bounded observation roots (D3). */
export type MacosScopeOptions = {
  /** Home directory to expand home-relative roots against; defaults to `$HOME`. */
  home?: string;
  /** Extra absolute roots to add (user-configurable scope, D3). */
  include?: AbsolutePath[];
  /** Absolute roots to drop from the defaults (user-configurable scope, D3). */
  exclude?: AbsolutePath[];
};

/**
 * Expands a platform table into the bounded absolute roots the macOS heuristic backend observes. On
 * macOS this is the table's absolute `scopeRoots` plus its home-relative `searchRootsInHome` and home
 * shell config files (the plan's fallback scope, D3). There is no other exclusion list: the table is
 * the bound, and it is revisited with fixtures rather than padded with skips. Roots are sorted and
 * de-duplicated so a journal is deterministic.
 */
export function macosHeuristicRoots(options: MacosScopeOptions = {}, platform: Platform = MACOS_PLATFORM): AbsolutePath[] {
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
