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
