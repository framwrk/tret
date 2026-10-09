import type { AbsolutePath, Privilege } from "../../types";
import type { CpuArch, Platform, PlatformId } from "./types";
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
 * Resolves a record's `caseSensitive` flag from the platform probe for `path`, falling back to the
 * platform's last-resort default when the mount cannot be probed (D10).
 */
export function caseSensitiveFor(platform: Platform, path?: AbsolutePath): boolean {
  const detected = path === undefined ? "unknown" : platform.case.detect(path);
  if (detected === "sensitive") return true;
  if (detected === "insensitive") return false;
  return platform.case.defaultCaseSensitive;
}

/** The privilege the process is running under; recorded from the process, never escalated (D8). */
export function processPrivilege(): Privilege {
  return process.getuid?.() === 0 ? "root" : "user";
}
