import { LINUX_PLATFORM, MACOS_PLATFORM, hostArch, platformFor } from "./index";
import { describe, expect, test } from "bun:test";
import type { Platform } from "./types";

// The pre-rewrite macOS tables, copied here verbatim so the platform seam is provably equivalent.
const LEGACY_SNAPSHOT_ROOTS = ["/opt/homebrew/bin", "/usr/local/bin"];

const LEGACY_SEARCH_DIRS_IN_HOME = [
  ".cache",
  ".config",
  ".local/bin",
  ".local/share",
  ".local/state",
  "Library/Application Support",
  "Library/Caches",
  "Library/Containers",
  "Library/HTTPStorages",
  "Library/LaunchAgents",
  "Library/Logs",
  "Library/Preferences",
  "Library/Saved Application State",
  "Library/WebKit",
];

const LEGACY_SHARED_IN_HOME = [
  ".config",
  ".cache",
  ".local",
  ".local/bin",
  ".local/lib",
  ".local/share",
  ".local/state",
  ".ssh",
  ".zshrc.d",
  "Applications",
  "Library",
  "bin",
  "go",
  "go/bin",
];

const LEGACY_SHARED_ABSOLUTE = [
  "/",
  "/Applications",
  "/Library",
  "/bin",
  "/etc",
  "/opt",
  "/opt/homebrew",
  "/opt/homebrew/bin",
  "/sbin",
  "/tmp",
  "/usr",
  "/usr/bin",
  "/usr/lib",
  "/usr/local",
  "/usr/local/bin",
  "/usr/local/lib",
  "/usr/local/share",
  "/usr/share",
  "/var",
];

const LEGACY_RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"];

describe("platform tables", () => {
  test("both tables satisfy the Platform contract", () => {
    const platforms: Platform[] = [MACOS_PLATFORM, LINUX_PLATFORM];
    expect(platforms.map((platform) => platform.id)).toEqual(["darwin", "linux"]);
    expect(platformFor("darwin")).toBe(MACOS_PLATFORM);
    expect(platformFor("linux")).toBe(LINUX_PLATFORM);
  });

  test("hostArch maps to a release architecture", () => {
    expect(["arm64", "x64"]).toContain(hostArch());
  });

  test("macOS preserves the pre-rewrite snapshot and search roots", () => {
    expect(MACOS_PLATFORM.scopeRoots).toEqual(LEGACY_SNAPSHOT_ROOTS);
    expect(MACOS_PLATFORM.searchRootsAbsolute).toEqual(LEGACY_SNAPSHOT_ROOTS);
    expect(MACOS_PLATFORM.searchRootsInHome).toEqual(LEGACY_SEARCH_DIRS_IN_HOME);
  });

  test("macOS keeps volatile ~/Library roots out of the capture scope (D3 revision, defect #2)", () => {
    const capture = MACOS_PLATFORM.captureRootsInHome;
    expect(capture).toContain(".config");
    expect(capture).toContain(".local/bin");
    expect(capture).toContain(".local/lib");
    expect(capture).toContain(".local/share");
    expect(capture).toContain(".local/state");
    expect(capture).toContain("Library/Application Support");
    expect(capture).toContain("Library/LaunchAgents");
    for (const dropped of [
      ".cache",
      "Library/Caches",
      "Library/Containers",
      "Library/HTTPStorages",
      "Library/Logs",
      "Library/Preferences",
      "Library/Saved Application State",
      "Library/WebKit",
    ]) {
      expect(capture).not.toContain(dropped);
    }
  });

  test("macOS preserves the pre-rewrite uninstall guards", () => {
    expect(MACOS_PLATFORM.sharedAbsolute).toEqual(LEGACY_SHARED_ABSOLUTE);
    expect(MACOS_PLATFORM.sharedInHome).toEqual(LEGACY_SHARED_IN_HOME);
  });

  test("macOS preserves the pre-rewrite shell config files", () => {
    const homeFiles = MACOS_PLATFORM.shellConfigs.filter((config) => config.scope === "home").map((config) => config.path);
    expect(homeFiles).toEqual(LEGACY_RC_FILES);
    expect(MACOS_PLATFORM.shellConfigs.every((config) => config.kind === "file")).toBe(true);
  });

  test("Linux replaces the macOS-only surfaces with XDG and package-manager roots", () => {
    expect(LINUX_PLATFORM.scopeRoots).toEqual(["/usr/bin", "/usr/local/bin", "/opt"]);
    expect(LINUX_PLATFORM.sharedAbsolute).not.toContain("/Applications");
    expect(LINUX_PLATFORM.sharedAbsolute).not.toContain("/opt/homebrew");
    expect(LINUX_PLATFORM.searchRootsInHome).toContain(".config/systemd/user");
    expect(LINUX_PLATFORM.searchRootsInHome).toContain(".local/share/applications");
    expect(LINUX_PLATFORM.searchRootsInHome).toContain(".cargo/bin");
  });

  test("Linux shell configs are per-shell and include fish and /etc/profile.d", () => {
    const paths = LINUX_PLATFORM.shellConfigs.map((config) => config.path);
    expect(paths).toContain(".bash_login");
    expect(paths).toContain(".config/fish/config.fish");

    const profileD = LINUX_PLATFORM.shellConfigs.find((config) => config.path === "/etc/profile.d");
    expect(profileD).toMatchObject({ scope: "absolute", kind: "directory" });
  });

  test("artifact naming follows the os/arch matrix (D9)", () => {
    expect(MACOS_PLATFORM.artifacts.archiveName("arm64")).toBe("tret-darwin-arm64.tar.gz");
    expect(MACOS_PLATFORM.artifacts.archiveName("x64")).toBe("tret-darwin-x64.tar.gz");
    expect(LINUX_PLATFORM.artifacts.archiveName("arm64")).toBe("tret-linux-arm64.tar.gz");
    expect(LINUX_PLATFORM.artifacts.archiveName("x64")).toBe("tret-linux-x64.tar.gz");
    expect(MACOS_PLATFORM.artifacts.hashCommand).toBe("shasum -a 256");
    expect(LINUX_PLATFORM.artifacts.hashCommand).toBe("sha256sum");
    expect(MACOS_PLATFORM.artifacts.checksumFile).toBe("checksums.txt");
  });

  test("both platforms support privileged installs but never escalate silently (D8)", () => {
    for (const platform of [MACOS_PLATFORM, LINUX_PLATFORM]) {
      expect(platform.privilege.support).toBe("supported");
      expect(platform.privilege.defaultPrivilege).toBe("user");
      expect(platform.privilege.sudoAwareUninstall).toBe(true);
      expect(platform.privilege.neverEscalate).toBe(true);
    }
  });

  test("case behavior defaults match each OS and the stub reports them (D10)", () => {
    expect(MACOS_PLATFORM.case.defaultCaseSensitive).toBe(false);
    expect(MACOS_PLATFORM.case.detect("/tmp")).toBe("insensitive");
    expect(LINUX_PLATFORM.case.defaultCaseSensitive).toBe(true);
    expect(LINUX_PLATFORM.case.detect("/tmp")).toBe("sensitive");
  });
});
