import type { Platform } from "./types";

/**
 * Linux platform table (plan section 8, D3). It replaces the macOS `/Applications` and `~/Library`
 * assumptions with the XDG and package-manager surfaces Linux installers write to. No Homebrew
 * scope is added. This table is not wired into the running commands yet; Phase 2 only freezes it.
 */
export const LINUX_PLATFORM: Platform = {
  id: "linux",
  label: "Linux",
  scopeRoots: ["/usr/bin", "/usr/local/bin", "/opt"],
  searchRootsInHome: [
    ".cache",
    ".config",
    ".config/systemd/user",
    ".local/bin",
    ".local/lib",
    ".local/share",
    ".local/share/applications",
    ".local/state",
    ".cargo/bin",
  ],
  // Capture surfaces match the search roots minus `.cache`: no installer owns a shared cache, and
  // the Linux tracer does not need a broader scope than the tool directories it already records.
  captureRootsInHome: [
    ".config",
    ".config/systemd/user",
    ".local/bin",
    ".local/lib",
    ".local/share",
    ".local/share/applications",
    ".local/state",
    ".cargo/bin",
  ],
  searchRootsAbsolute: ["/usr/bin", "/usr/local/bin", "/opt"],
  sharedAbsolute: [
    "/",
    "/bin",
    "/etc",
    "/opt",
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
    ".cache",
    ".cargo",
    ".cargo/bin",
    ".config",
    ".config/systemd/user",
    ".local",
    ".local/bin",
    ".local/lib",
    ".local/share",
    ".local/share/applications",
    ".local/state",
    ".ssh",
  ],
  shellConfigs: [
    { shell: "zsh", scope: "home", path: ".zshrc", kind: "file" },
    { shell: "zsh", scope: "home", path: ".zprofile", kind: "file" },
    { shell: "zsh", scope: "home", path: ".zshenv", kind: "file" },
    { shell: "bash", scope: "home", path: ".bashrc", kind: "file" },
    { shell: "bash", scope: "home", path: ".bash_profile", kind: "file" },
    { shell: "bash", scope: "home", path: ".bash_login", kind: "file" },
    { shell: "sh", scope: "home", path: ".profile", kind: "file" },
    { shell: "fish", scope: "home", path: ".config/fish/config.fish", kind: "file" },
    { shell: "sh", scope: "absolute", path: "/etc/profile.d", kind: "directory" },
  ],
  privilege: {
    support: "supported",
    defaultPrivilege: "user",
    sudoAwareUninstall: true,
    neverEscalate: true,
  },
  artifacts: {
    binary: "tret",
    archiveName: (arch) => `tret-linux-${arch}.tar.gz`,
    checksumFile: "checksums.txt",
    hashCommand: "sha256sum",
  },
  case: {
    defaultCaseSensitive: true,
    // Phase 2 stub: per-mount probing lands with storage/uninstall (D10).
    detect: () => "sensitive",
  },
};
