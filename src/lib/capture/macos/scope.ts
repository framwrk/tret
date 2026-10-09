import type { AbsolutePath } from "../../../types";
import { MACOS_PLATFORM } from "../../platform";
import type { ObservationRootsOptions } from "../../platform/roots";
import type { Platform } from "../../platform";
import { observationRoots } from "../../platform/roots";

/** Options for expanding a platform table into bounded observation roots (D3). */
export type MacosScopeOptions = ObservationRootsOptions;

/**
 * Expands a platform table into the bounded absolute roots the macOS heuristic backend observes. On
 * macOS this is the table's absolute `scopeRoots` plus its home-relative `searchRootsInHome` and home
 * shell config files (the plan's fallback scope, D3). There is no other exclusion list: the table is
 * the bound, and it is revisited with fixtures rather than padded with skips. Roots are sorted and
 * de-duplicated so a journal is deterministic.
 */
export function macosHeuristicRoots(options: MacosScopeOptions = {}, platform: Platform = MACOS_PLATFORM): AbsolutePath[] {
  return observationRoots(platform, options);
}
