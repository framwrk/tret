import { NativeDirectory, nativeParent } from "./native-filesystem";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-native-filesystem-"));
  roots.push(root);
  return root;
}

test("an ancestor symlink swap cannot redirect hashing or a directory-relative move", () => {
  const root = fixture();
  const original = join(root, "parent");
  const unrelated = join(root, "unrelated");
  mkdirSync(original);
  mkdirSync(unrelated);
  writeFileSync(join(original, "file"), "approved");
  writeFileSync(join(unrelated, "file"), "keep sentinel");
  const parent = new NativeDirectory(original);
  const stage = parent.createDirectory("stage");
  try {
    const approved = parent.inspect("file")!;
    renameSync(original, join(root, "moved-parent"));
    symlinkSync(unrelated, original);
    expect(parent.hash("file", approved)).toBe(new Bun.CryptoHasher("sha256").update("approved").digest("hex"));
    parent.moveExclusive("file", stage, "captured");
    expect(stage.inspect("captured")?.ino).toBe(approved.ino);
    expect(readFileSync(join(unrelated, "file"), "utf8")).toBe("keep sentinel");
    expect(existsSync(join(root, "moved-parent", "stage", "captured"))).toBe(true);
  } finally {
    stage.close();
    parent.close();
  }
});

test("exclusive moves preserve an occupied destination and the source", () => {
  const root = fixture();
  writeFileSync(join(root, "source"), "approved");
  writeFileSync(join(root, "destination"), "keep");
  const directory = new NativeDirectory(root);
  try {
    expect(() => directory.moveExclusive("source", directory, "destination")).toThrow("exclusive");
    expect(readFileSync(join(root, "source"), "utf8")).toBe("approved");
    expect(readFileSync(join(root, "destination"), "utf8")).toBe("keep");
  } finally {
    directory.close();
  }
});

test("metadata opens a final symlink itself; removal never follows it", () => {
  const root = fixture();
  writeFileSync(join(root, "sentinel"), "keep");
  symlinkSync("sentinel", join(root, "link"));
  const parent = new NativeDirectory(root);
  const stage = parent.createDirectory("stage");
  try {
    expect(parent.inspect("link")?.kind).toBe("symlink");
    expect(parent.linkTarget("link")).toBe("sentinel");
    parent.moveExclusive("link", stage, "captured");
    stage.unlink("captured", "symlink");
    expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("keep");
  } finally {
    stage.close();
    parent.close();
  }
});

test("directory removal is non-recursive and preserves newly added children", () => {
  const root = fixture();
  mkdirSync(join(root, "payload"));
  writeFileSync(join(root, "payload", "sentinel"), "keep");
  const directory = new NativeDirectory(root);
  try {
    expect(() => directory.unlink("payload", "directory")).toThrow("removal refused");
    expect(readFileSync(join(root, "payload", "sentinel"), "utf8")).toBe("keep");
  } finally {
    directory.close();
  }
});

test("special nodes are inspected without blocking and cannot be hashed", () => {
  const root = fixture();
  const fifo = join(root, "fifo");
  execFileSync("mkfifo", [fifo]);
  const { directory, name } = nativeParent(fifo);
  try {
    const state = directory.inspect(name)!;
    expect(state.kind).toBe("unsupported");
    expect(() => directory.hash(name, state)).toThrow("requires a regular file");
    expect(directory.inspect("absent")).toBeUndefined();
    expect(() => directory.inspect("../outside")).toThrow("one path component");
  } finally {
    directory.close();
  }
});
