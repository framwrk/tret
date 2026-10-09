// Cross-platform release artifact selection (plan section 8, decision D9).
//
// The build, `scripts/install.sh`, and the self-update check all need to name the
// same release artifact for the same OS/arch. Keeping the mapping in one pure
// module lets it be tested across every target without touching the network, and
// gives the compiled binary an authoritative answer for the update check.

/** Operating-system identifier used in release artifact names (matches `uname -s`/`process.platform`). */
export type PlatformId = "darwin" | "linux";

/** CPU architecture used in release artifact names (matches `uname -m`/`process.arch`). */
export type CpuArch = "arm64" | "x64";

/** The release naming and integrity tooling for one supported target. */
export type Artifact = {
  os: PlatformId;
  arch: CpuArch;
  /** Raw compiled executable name; also the checksum entry the install and update skip-logic compare against. */
  binary: string;
  /** Published archive filename that carries the binary. */
  archive: string;
  /** SHA-256 command available on the platform (`shasum -a 256` on macOS, `sha256sum` on Linux). */
  hashCommand: string;
  /** Checksum manifest published alongside the archives. */
  checksumFile: string;
};

/** The single checksum manifest every release publishes. */
export const CHECKSUM_FILE = "checksums.txt";

const PLATFORM_IDS: readonly PlatformId[] = ["darwin", "linux"];
const CPU_ARCHS: readonly CpuArch[] = ["arm64", "x64"];

/** True when `value` is a supported operating-system id. */
export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

/** True when `value` is a supported architecture in its canonical form. */
export function isCpuArch(value: string): value is CpuArch {
  return (CPU_ARCHS as readonly string[]).includes(value);
}

/** Maps a `uname -s` value to a release OS, or undefined when Tret does not target it. */
export function platformFromUname(unameS: string): PlatformId | undefined {
  switch (unameS) {
    case "Darwin":
      return "darwin";
    case "Linux":
      return "linux";
    default:
      return undefined;
  }
}

/** Maps a `uname -m` value to a release architecture, or undefined when Tret does not target it. */
export function archFromUname(unameM: string): CpuArch | undefined {
  switch (unameM) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x86_64":
    case "amd64":
      return "x64";
    default:
      return undefined;
  }
}

/** Builds the release artifact descriptor for one OS/arch pair. */
export function artifactFor(os: PlatformId, arch: CpuArch): Artifact {
  const binary = `tret-${os}-${arch}`;
  return {
    os,
    arch,
    binary,
    archive: `${binary}.tar.gz`,
    hashCommand: os === "darwin" ? "shasum -a 256" : "sha256sum",
    checksumFile: CHECKSUM_FILE,
  };
}

/**
 * Resolves a release artifact from `uname -s`/`uname -m` output, the mapping
 * `scripts/install.sh` mirrors in shell. Returns undefined when unsupported.
 */
export function artifactFromUname(unameS: string, unameM: string): Artifact | undefined {
  const os = platformFromUname(unameS);
  const arch = archFromUname(unameM);
  return os && arch ? artifactFor(os, arch) : undefined;
}

/**
 * The release artifact for the running process, or undefined when Tret does not
 * target this OS/arch. `process.platform`/`process.arch` already use the
 * canonical names on the supported platforms; the explicit parameters keep the
 * function pure and testable.
 */
export function hostArtifact(platform: string = process.platform, arch: string = process.arch): Artifact | undefined {
  const os = isPlatformId(platform) ? platform : platformFromUname(platform);
  const cpu = isCpuArch(arch) ? arch : archFromUname(arch);
  return os && cpu ? artifactFor(os, cpu) : undefined;
}
