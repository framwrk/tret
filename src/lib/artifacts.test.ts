import {
  archFromUname,
  artifactFor,
  artifactFromUname,
  hostArtifact,
  isCpuArch,
  isPlatformId,
  platformFromUname,
} from "./artifacts";
import { describe, expect, test } from "bun:test";

describe("artifact selection (D9)", () => {
  test("names every target as tret-{os}-{arch} with a .tar.gz archive", () => {
    expect(artifactFor("darwin", "arm64")).toMatchObject({
      binary: "tret-darwin-arm64",
      archive: "tret-darwin-arm64.tar.gz",
    });
    expect(artifactFor("darwin", "x64")).toMatchObject({
      binary: "tret-darwin-x64",
      archive: "tret-darwin-x64.tar.gz",
    });
    expect(artifactFor("linux", "arm64")).toMatchObject({
      binary: "tret-linux-arm64",
      archive: "tret-linux-arm64.tar.gz",
    });
    expect(artifactFor("linux", "x64")).toMatchObject({
      binary: "tret-linux-x64",
      archive: "tret-linux-x64.tar.gz",
    });
  });

  test("selects the SHA-256 tool each platform ships", () => {
    expect(artifactFor("darwin", "arm64").hashCommand).toBe("shasum -a 256");
    expect(artifactFor("darwin", "x64").hashCommand).toBe("shasum -a 256");
    expect(artifactFor("linux", "arm64").hashCommand).toBe("sha256sum");
    expect(artifactFor("linux", "x64").hashCommand).toBe("sha256sum");
    expect(artifactFor("linux", "x64").checksumFile).toBe("checksums.txt");
    expect(artifactFor("darwin", "arm64").checksumFile).toBe("checksums.txt");
  });

  test("maps uname -s output", () => {
    expect(platformFromUname("Darwin")).toBe("darwin");
    expect(platformFromUname("Linux")).toBe("linux");
    expect(platformFromUname("Windows_NT")).toBeUndefined();
    expect(platformFromUname("FreeBSD")).toBeUndefined();
  });

  test("maps uname -m output, including Linux spellings", () => {
    expect(archFromUname("arm64")).toBe("arm64");
    expect(archFromUname("aarch64")).toBe("arm64");
    expect(archFromUname("x86_64")).toBe("x64");
    expect(archFromUname("amd64")).toBe("x64");
    expect(archFromUname("i686")).toBeUndefined();
    expect(archFromUname("riscv64")).toBeUndefined();
  });

  test("resolves an artifact from uname for all four supported targets", () => {
    expect(artifactFromUname("Darwin", "arm64")?.archive).toBe("tret-darwin-arm64.tar.gz");
    expect(artifactFromUname("Darwin", "x86_64")?.archive).toBe("tret-darwin-x64.tar.gz");
    expect(artifactFromUname("Linux", "aarch64")?.archive).toBe("tret-linux-arm64.tar.gz");
    expect(artifactFromUname("Linux", "x86_64")?.archive).toBe("tret-linux-x64.tar.gz");
  });

  test("returns undefined for unsupported platforms and mismatched pairs", () => {
    expect(artifactFromUname("Windows_NT", "x86_64")).toBeUndefined();
    expect(artifactFromUname("Darwin", "riscv64")).toBeUndefined();
    expect(hostArtifact("win32", "x64")).toBeUndefined();
    expect(hostArtifact("darwin", "ia32")).toBeUndefined();
  });

  test("hostArtifact matches the running process on a supported host", () => {
    const artifact = hostArtifact();
    expect(artifact).toBeDefined();
    expect(isPlatformId(artifact!.os)).toBe(true);
    expect(isCpuArch(artifact!.arch)).toBe(true);
    expect(artifact!.binary).toBe(`tret-${artifact!.os}-${artifact!.arch}`);
  });

  test("hostArtifact accepts uname spellings and process names alike", () => {
    expect(hostArtifact("darwin", "arm64")?.binary).toBe("tret-darwin-arm64");
    expect(hostArtifact("Darwin", "x86_64")?.binary).toBe("tret-darwin-x64");
    expect(hostArtifact("linux", "aarch64")?.binary).toBe("tret-linux-arm64");
    expect(hostArtifact("linux", "x64")?.binary).toBe("tret-linux-x64");
  });
});
