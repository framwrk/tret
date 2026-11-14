import { type FilesystemIdentity, filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity";
import { type NodeIdentity, nativeParent, sameNode } from "./native-filesystem";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { privateStateFilter } from "./capture/self-state";
import { realpathSync } from "node:fs";

export type CleanupSnapshot = {
  path: string;
  parent: NodeIdentity;
  node: NodeIdentity | null;
  ancestors: FilesystemIdentity;
  hash?: string;
  linkTarget?: string;
};

export type CleanupApproval = {
  action: "remove" | "restore";
  approvedAt: string;
  current: CleanupSnapshot;
};

export function canonicalCandidate(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

/** One root policy for approval, planning and application, including legacy-record candidates. */
export function protectedCleanupPath(path: string, home = process.env.HOME): string | undefined {
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").includes("..")) return "unsafe path spelling";
  let canonical: string;
  try {
    canonical = join(realpathSync(dirname(path)), basename(path));
  } catch {
    return "parent cannot be resolved safely";
  }
  const protectedRoots = new Set([
    "/",
    "/bin",
    "/sbin",
    "/usr",
    "/usr/bin",
    "/usr/sbin",
    "/usr/local",
    "/usr/local/bin",
    "/usr/local/lib",
    "/opt",
    "/etc",
    "/var",
    "/tmp",
    "/private",
    "/private/etc",
    "/private/var",
    "/private/tmp",
    "/Users",
    "/home",
    "/root",
  ]);
  if (home) {
    let actualHome: string;
    try {
      actualHome = realpathSync(home);
    } catch {
      actualHome = resolve(home);
    }
    for (const root of [resolve(home), actualHome]) {
      for (const suffix of [
        "",
        ".config",
        ".cache",
        ".local",
        ".local/bin",
        ".local/share",
        "bin",
        "Library",
        "Library/Application Support",
      ]) {
        protectedRoots.add(join(root, suffix));
      }
    }
  }
  const privateState = privateStateFilter(home);
  if (privateState(path) || privateState(canonical)) return "private Tret state";
  if (protectedRoots.has(path) || protectedRoots.has(canonical)) return "protected or shared root";
  return undefined;
}

/** Captures the exact current object; this observation becomes authority only after explicit consent. */
export function cleanupSnapshot(path: string): CleanupSnapshot {
  const ancestors = filesystemIdentity(path);
  if (!ancestors) throw new Error("object or ancestor identity is unreadable");
  const { directory, name } = nativeParent(path);
  try {
    const node = directory.inspect(name) ?? null;
    if (node?.kind === "unsupported" || (node?.kind === "file" && node.links !== "1"))
      throw new Error("special nodes and hard-link aliases require manual reconciliation");
    if (node && node.mode & 0o7000) throw new Error("special permission bits require manual reconciliation");
    const snapshot: CleanupSnapshot = {
      path,
      parent: directory.identity,
      node,
      ancestors,
      ...(node?.kind === "file" ? { hash: directory.hash(name, node) } : {}),
      ...(node?.kind === "symlink" ? { linkTarget: directory.linkTarget(name) } : {}),
    };
    const after = directory.inspect(name) ?? null;
    if (
      (node && (!after || !sameNode(after, node))) ||
      (!node && after) ||
      !sameFilesystemIdentity(ancestors, filesystemIdentity(path))
    ) {
      throw new Error("object changed while its approval was being prepared");
    }
    return snapshot;
  } finally {
    directory.close();
  }
}

export function sameApprovedSnapshot(expected: CleanupSnapshot, actual: CleanupSnapshot): boolean {
  if (
    expected.path !== actual.path ||
    expected.parent.dev !== actual.parent.dev ||
    expected.parent.ino !== actual.parent.ino ||
    expected.parent.kind !== actual.parent.kind ||
    expected.parent.mode !== actual.parent.mode ||
    expected.parent.uid !== actual.parent.uid ||
    expected.parent.gid !== actual.parent.gid ||
    !sameFilesystemIdentity(expected.ancestors, actual.ancestors)
  )
    return false;
  if (!expected.node || !actual.node) return expected.node === actual.node;
  const same =
    expected.node.kind === "directory"
      ? (["dev", "ino", "kind", "mode", "uid", "gid"] as const).every((key) => expected.node![key] === actual.node![key])
      : sameNode(expected.node, actual.node);
  return same && expected.hash === actual.hash && expected.linkTarget === actual.linkTarget;
}

/** Strictly reject unknown authorization kinds; old v4 builds must not ignore future semantics. */
export function validCleanupApproval(value: unknown, path: string): value is CleanupApproval {
  if (
    !object(value) ||
    (value.action !== "remove" && value.action !== "restore") ||
    typeof value.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(value.approvedAt))
  )
    return false;
  const current = value.current;
  if (
    !object(current) ||
    current.path !== path ||
    !validNode(current.parent) ||
    current.parent.kind !== "directory" ||
    (current.node !== null && !validNode(current.node)) ||
    !object(current.ancestors)
  )
    return false;
  if (
    !Object.entries(current.ancestors).every(
      ([key, signature]) => isAbsolute(key) && (signature === null || typeof signature === "string"),
    )
  )
    return false;
  if (value.action === "remove" && current.node === null) return false;
  if (current.node !== null) {
    if (current.node.kind === "unsupported" || (current.node.mode & 0o7000) !== 0) return false;
    if (
      current.node.kind === "file" &&
      (current.node.links !== "1" || typeof current.hash !== "string" || !/^[a-f0-9]{64}$/.test(current.hash))
    )
      return false;
    if (current.node.kind === "symlink" && typeof current.linkTarget !== "string") return false;
  }
  return true;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validNode(value: unknown): value is NodeIdentity {
  if (
    !object(value) ||
    !["file", "directory", "symlink", "unsupported"].includes(String(value.kind)) ||
    typeof value.mode !== "number" ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o7777
  )
    return false;
  if (
    !["dev", "ino", "uid", "gid", "links", "size"].every(
      (key) => typeof value[key] === "string" && /^(0|[1-9][0-9]*)$/.test(value[key] as string),
    )
  )
    return false;
  return ["mtime", "ctime"].every((key) => typeof value[key] === "string" && /^-?[0-9]+$/.test(value[key] as string));
}
