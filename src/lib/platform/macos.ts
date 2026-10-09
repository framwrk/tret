import type { Platform } from "./types";

/**
 * macOS platform table. The legacy path tables (`SNAPSHOT_ROOTS`, `SHARED_ABSOLUTE`/`SHARED_IN_HOME`,
 * `SEARCH_DIRS_IN_HOME`, `RC_FILES`) reproduce the pre-rewrite macOS-only behavior exactly so the
 * existing modules keep behaving identically while reading from this seam. No new Homebrew scope is
 * added; the two `/opt/homebrew` roots already present are preserved for equivalence.
 *
 * `captureRootsInHome` is the one deliberate departure from the legacy search table (D3 revision,
 * defect #2). The pre-rewrite capture skipped `~/Library` entirely via `EXCLUDED_PATHS`, so a
 * scoped capture must not scan the volatile Library subtrees the rewrite first carried over from
 * `tret find`'s search list. Capture keeps only the surfaces an installer genuinely targets;
 * `searchRootsInHome` stays broad so `tret find` can still adopt tool files by hand.
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
  // Curated install surfaces only. Dropped as pure churn (no installer target): `.cache`,
  // `Library/Caches`, `Library/Containers`, `Library/HTTPStorages`, `Library/Logs`,
  // `Library/Saved Application State`, `Library/WebKit`. `Library/Preferences` is dropped too:
  // cfprefsd rewrites `*.plist` continuously and no filename rule separates that churn from a real
  // install write. `Library/Application Support` stays because it holds real tool state; its known
  // churn shapes are skipped at scan time (see `isVolatileChurnPath`).
  captureRootsInHome: [
    ".config",
    ".local/bin",
    ".local/lib",
    ".local/share",
    ".local/state",
    "Library/Application Support",
    "Library/LaunchAgents",
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
