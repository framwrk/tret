import type { Platform } from "./types";
import { detectCaseBehavior } from "./case";

/**
 * Linux platform table (plan section 8, D3). It replaces the macOS `/Applications` and `~/Library`
 * assumptions with the XDG and package-manager surfaces Linux installers write to. No Homebrew
 * scope is added. The running commands select it through `currentPlatform()`.
 */
export const LINUX_PLATFORM: Platform = {
  id: "linux",
  label: "Linux",
  // `/opt` is deliberately not a capture root: it is an unbounded shared system tree (a runner's
  // /opt/hostedtoolcache is a multi-GB tool cache), so observing it whole costs far more than the
  // tool directories Tret targets. `tret find` still searches it via `searchRootsAbsolute`.
  scopeRoots: ["/usr/bin", "/usr/local/bin"],
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
  // Installs also observe `$HOME` itself, like macOS, so a tool that drops a dotfile or
  // dot-directory outside the XDG roots (`.pi`, `.toolrc`, `.bun`) is captured instead of the
  // install being unobservable. The shared skip rules and the scope filter keep caches, dependency
  // trees and `node_modules` payloads out of the journal.
  captureHomeRoot: true,
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
    detect: detectCaseBehavior,
  },
};
