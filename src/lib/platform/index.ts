import type { AbsolutePath, Privilege } from "../../types";
import type { CaseDetection, CpuArch, Platform, PlatformId } from "./types";
import { LINUX_PLATFORM } from "./linux";
import { MACOS_PLATFORM } from "./macos";

export * from "./roots";
export * from "./types";
export { LINUX_PLATFORM, MACOS_PLATFORM };

const PLATFORMS: Record<PlatformId, Platform> = { darwin: MACOS_PLATFORM, linux: LINUX_PLATFORM };

/** Returns the platform table for an operating-system id. */
export function platformFor(id: PlatformId): Platform {
  return PLATFORMS[id];
}

/** Returns the table for the running OS; throws on a platform Tret does not target. */
export function currentPlatform(): Platform {
  const id = process.platform;
  if (id === "darwin" || id === "linux") return PLATFORMS[id];
  throw new Error(`tret does not support this platform: ${id}`);
}

/** Maps the running architecture to a release-artifact architecture. */
export function hostArch(): CpuArch {
  return process.arch === "arm64" ? "arm64" : "x64";
}

/**
 * Resolves the one case flag a record covers from every path it observes (D10). A record can span
 * mounts, so the reduction is deliberately conservative: any case-sensitive path makes the whole
 * record case-sensitive, because wrongly merging two distinct paths loses one of them, while
 * wrongly keeping both spellings apart only records duplicate work. Paths that could not be probed
 * defer to the ones that could, and, as a last resort, to the platform default.
 */
export function caseSensitiveForPaths(platform: Platform, paths: AbsolutePath[]): boolean {
  const detected: CaseDetection[] = paths.map((path) => platform.case.detect(path));
  if (detected.includes("sensitive")) return true;
  if (detected.includes("insensitive")) return false;
  return platform.case.defaultCaseSensitive;
}

/** The privilege the process is running under; recorded from the process, never escalated (D8). */
export function processPrivilege(): Privilege {
  return process.getuid?.() === 0 ? "root" : "user";
}
