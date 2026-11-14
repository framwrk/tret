import { type Pointer, dlopen, toArrayBuffer } from "bun:ffi";
import { basename, dirname, isAbsolute } from "node:path";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";

/** Decimal strings preserve inode/device precision across JSON and JavaScript. */
export type NodeIdentity = {
  dev: string;
  ino: string;
  kind: "file" | "directory" | "symlink" | "unsupported";
  mode: number;
  uid: string;
  gid: string;
  links: string;
  size: string;
  mtime: string;
  ctime: string;
};

/** Narrow unprivileged bindings to the platform's existing libc; no helper executable. */
function bind() {
  const symbols = {
    openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
    mkdirat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    readlinkat: { args: ["i32", "ptr", "ptr", "u64"], returns: "i64" },
  } as const;
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      ...symbols,
      __error: { args: [], returns: "ptr" },
      renameatx_np: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    });
    return {
      ...library.symbols,
      errno: () => errorNumber(library.symbols.__error()),
      renameExclusive: (from: number, name: Uint8Array, to: number, target: Uint8Array) =>
        library.symbols.renameatx_np(from, name, to, target, 4),
      // O_SYMLINK opens the link itself. Combining it with O_NOFOLLOW instead returns ELOOP.
      metadataFlags: 0x00008000 | 0x00200000, // O_EVTONLY | O_SYMLINK (Darwin SDK).
      removeDirectory: 0x0080,
      close: library.close,
    };
  }
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      ...symbols,
      __errno_location: { args: [], returns: "ptr" },
      renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    });
    return {
      ...library.symbols,
      errno: () => errorNumber(library.symbols.__errno_location()),
      renameExclusive: (from: number, name: Uint8Array, to: number, target: Uint8Array) =>
        library.symbols.renameat2(from, name, to, target, 1),
      metadataFlags: 0x00200000 | constants.O_NOFOLLOW, // O_PATH: metadata only, including special nodes.
      removeDirectory: 0x0200,
      close: library.close,
    };
  }
  throw new Error(`safe filesystem application is unsupported on ${process.platform}`);
}

function errorNumber(pointer: Pointer | null): number {
  if (!pointer) throw new Error("cannot read native filesystem error");
  return new Int32Array(toArrayBuffer(pointer, 0, 4))[0]!;
}

function nameBytes(name: string): Uint8Array {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new Error("native action requires one path component");
  return new TextEncoder().encode(name + "\0");
}

export function descriptorIdentity(fd: number): NodeIdentity {
  const node = fstatSync(fd, { bigint: true });
  return {
    dev: String(node.dev),
    ino: String(node.ino),
    kind: node.isFile() ? "file" : node.isDirectory() ? "directory" : node.isSymbolicLink() ? "symlink" : "unsupported",
    mode: Number(node.mode & 0o7777n),
    uid: String(node.uid),
    gid: String(node.gid),
    links: String(node.nlink),
    size: String(node.size),
    mtime: String(node.mtimeNs),
    ctime: String(node.ctimeNs),
  };
}

/**
 * Every child operation is relative to a pinned directory descriptor. The caller must compare
 * `identity` with its approved parent before any mutation. Existing ancestor aliases can resolve
 * during open; a later alias swap cannot redirect operations through this descriptor.
 */
export class NativeDirectory {
  private readonly native = bind();
  readonly fd: number = -1;
  readonly identity: NodeIdentity;
  private closed = false;

  constructor(path: string, relative?: { directory: NativeDirectory; name: string }) {
    try {
      if (relative) {
        this.fd = this.native.openat(
          relative.directory.fd,
          nameBytes(relative.name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          0,
        );
        if (this.fd < 0) throw new Error("cannot open the private action directory without following links");
      } else {
        if (!isAbsolute(path) || path.split("/").includes("..") || path.includes("\0"))
          throw new Error("native directory path must be absolute without parent traversal");
        this.fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
      }
      this.identity = descriptorIdentity(this.fd);
    } catch (error) {
      if (this.fd >= 0) closeSync(this.fd);
      this.native.close();
      throw error;
    }
  }

  /** Opens metadata without following the final link or reading a FIFO/device's contents. */
  inspect(name: string): NodeIdentity | undefined {
    this.assertOpen();
    const fd = this.native.openat(this.fd, nameBytes(name), this.native.metadataFlags | constants.O_NONBLOCK, 0);
    if (fd < 0) {
      if (this.native.errno() === 2) return undefined; // ENOENT is the only absence proof.
      throw new Error("cannot inspect the object without following its final link");
    }
    try {
      return descriptorIdentity(fd);
    } finally {
      closeSync(fd);
    }
  }

  linkTarget(name: string): string {
    this.assertOpen();
    const buffer = new Uint8Array(64 * 1024 + 1);
    const length = Number(this.native.readlinkat(this.fd, nameBytes(name), buffer, buffer.byteLength));
    if (length < 0 || length >= buffer.byteLength) throw new Error("link target is unreadable or exceeds 64 KiB");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  }

  /** Hashes a regular file with bounded memory; growing/changing files fail verification. */
  hash(name: string, expected: NodeIdentity, maxBytes = 4 * 1024 * 1024 * 1024, maxMs = 30_000): string {
    this.assertOpen();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isFinite(maxMs) || maxMs < 0)
      throw new Error("invalid content verification budget");
    if (expected.kind !== "file" || expected.links !== "1")
      throw new Error("content verification requires a regular file without hard-link aliases");
    const fd = this.native.openat(
      this.fd,
      nameBytes(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (fd < 0) throw new Error("cannot open the approved regular file without following links");
    try {
      if (!sameNode(descriptorIdentity(fd), expected)) throw new Error("file changed before hashing");
      const hasher = new Bun.CryptoHasher("sha256");
      const buffer = new Uint8Array(64 * 1024);
      const deadline = performance.now() + maxMs;
      let total = 0;
      for (;;) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.byteLength, maxBytes - total + 1), null);
        if (count === 0) break;
        total += count;
        if (total > maxBytes || performance.now() > deadline) throw new Error("content verification budget exhausted");
        hasher.update(buffer.subarray(0, count));
      }
      if (!sameNode(descriptorIdentity(fd), expected)) throw new Error("file changed while hashing");
      return hasher.digest("hex");
    } finally {
      closeSync(fd);
    }
  }

  createDirectory(name: string): NativeDirectory {
    this.assertOpen();
    if (this.native.mkdirat(this.fd, nameBytes(name), 0o700) !== 0)
      throw new Error("cannot exclusively create an action directory");
    return new NativeDirectory("", { directory: this, name });
  }

  /** Requires kernel/filesystem support for no-replace rename; there is no racy fallback. */
  moveExclusive(name: string, destination: NativeDirectory, target: string): void {
    this.assertOpen();
    destination.assertOpen();
    if (this.native.renameExclusive(this.fd, nameBytes(name), destination.fd, nameBytes(target)) !== 0) {
      throw new Error("exclusive directory-relative rename refused; source and destination require inspection");
    }
  }

  /** Empty directories only. The approved object must first be captured and verified privately. */
  unlink(name: string, kind: "file" | "symlink" | "directory"): void {
    this.assertOpen();
    if (this.native.unlinkat(this.fd, nameBytes(name), kind === "directory" ? this.native.removeDirectory : 0) !== 0) {
      throw new Error("directory-relative removal refused; object retained for recovery");
    }
  }

  writeExclusive(name: string, bytes: Uint8Array, mode: number): NodeIdentity {
    this.assertOpen();
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)
      throw new Error("restoration supports ordinary permission bits only");
    const fd = this.native.openat(
      this.fd,
      nameBytes(name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    if (fd < 0) throw new Error("cannot exclusively create restored content");
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) throw new Error("restoration write made no progress");
        offset += written;
      }
      fchmodSync(fd, mode);
      fsyncSync(fd);
      return descriptorIdentity(fd);
    } finally {
      closeSync(fd);
    }
  }

  sync(): void {
    this.assertOpen();
    fsyncSync(this.fd);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("native directory descriptor is closed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      this.native.close();
    }
  }
}

export function sameNode(actual: NodeIdentity, expected: NodeIdentity): boolean {
  return (["dev", "ino", "kind", "mode", "uid", "gid", "links", "size", "mtime", "ctime"] as const).every(
    (key) => actual[key] === expected[key],
  );
}

export function nativeParent(path: string): { directory: NativeDirectory; name: string } {
  if (!isAbsolute(path) || path.split("/").includes("..") || path.includes("\0"))
    throw new Error("action path must be absolute without parent traversal");
  return { directory: new NativeDirectory(dirname(path)), name: basename(path) };
}
