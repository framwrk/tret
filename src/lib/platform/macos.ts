import type { Platform } from "./types";

/**
 * macOS platform table. The path tables reproduce the pre-rewrite macOS-only behavior exactly
 * (`SNAPSHOT_ROOTS`, `SHARED_ABSOLUTE`/`SHARED_IN_HOME`, `SEARCH_DIRS_IN_HOME`, `RC_FILES`) so the
 * existing modules keep behaving identically while reading from this seam. No new Homebrew scope is
 * added; the two `/opt/homebrew` roots already present are preserved for equivalence.
 */
export const MACOS_PLATFORM: Platform = {
  id: "darwin",
  label: "macOS",
  scopeRoots: ["/opt/homebrew/bin", "/usr/local/bin"],
  // Observe `$HOME` top level too (defect #3): the pre-rewrite snapshot read `$HOME` bounded by
  // `EXCLUDED_PATHS`, so an installer's top-level dotfiles/dot-directories were recorded. The scoped
  // engine prunes this root with the same shared skip rules, so it stays a bounded scan.
  captureHomeRoot: true,
  searchRootsInHome: [
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
  ],
  searchRootsAbsolute: ["/opt/homebrew/bin", "/usr/local/bin"],
  sharedAbsolute: [
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
  ],
  sharedInHome: [
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
  ],
  shellConfigs: [
    { shell: "zsh", scope: "home", path: ".zshrc", kind: "file" },
    { shell: "zsh", scope: "home", path: ".zprofile", kind: "file" },
    { shell: "zsh", scope: "home", path: ".zshenv", kind: "file" },
    { shell: "bash", scope: "home", path: ".bashrc", kind: "file" },
    { shell: "bash", scope: "home", path: ".bash_profile", kind: "file" },
    { shell: "sh", scope: "home", path: ".profile", kind: "file" },
  ],
  privilege: {
    support: "supported",
    defaultPrivilege: "user",
    sudoAwareUninstall: true,
    neverEscalate: true,
  },
  artifacts: {
    binary: "tret",
    archiveName: (arch) => `tret-darwin-${arch}.tar.gz`,
    checksumFile: "checksums.txt",
    hashCommand: "shasum -a 256",
  },
  case: {
    defaultCaseSensitive: false,
    // Phase 2 stub: per-mount probing lands with storage/uninstall (D10).
    detect: () => "insensitive",
  },
};
