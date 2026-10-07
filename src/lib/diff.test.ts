import type { FileStamp, Snapshot } from "../types";
import { describe, expect, test } from "bun:test";
import { diff } from "./diff";

function snap(entries: Array<[string, FileStamp]>): Snapshot {
  return new Map(entries);
}

function stamp(mtimeMs: number, size: number, inode: number, isDir = false): FileStamp {
  return { mtimeMs, size, inode, isDir };
}

describe("diff", () => {
  test("classifies added, edited, and deleted paths", () => {
    const before = snap([
      ["/home/edited", stamp(2, 10, 100)],
      ["/home/deleted", stamp(3, 10, 101)],
      ["/home/kept", stamp(1, 10, 102)],
    ]);
    const after = snap([
      ["/home/added", stamp(5, 10, 103)],
      ["/home/edited", stamp(4, 10, 100)],
      ["/home/kept", stamp(1, 10, 102)],
    ]);

    expect(diff(before, after)).toEqual({
      added: ["/home/added"],
      edited: ["/home/edited"],
      deleted: ["/home/deleted"],
    });
  });

  test("returns empty arrays for identical snapshots", () => {
    const one = snap([
      ["/home/a", stamp(1, 10, 100)],
      ["/home/b", stamp(2, 20, 101)],
    ]);

    expect(diff(one, snap([...one]))).toEqual({
      added: [],
      edited: [],
      deleted: [],
    });
  });

  test("sorts paths deterministically", () => {
    const after = snap([
      ["/home/z", stamp(1, 10, 100)],
      ["/home/a", stamp(2, 10, 101)],
    ]);

    expect(diff(new Map(), after).added).toEqual(["/home/a", "/home/z"]);
  });

  test("omits files and subfolders inside an added folder", () => {
    const after = snap([
      ["/home/.config/opencode", stamp(1, 96, 100)],
      ["/home/.local/share/opencode", stamp(1, 96, 101)],
      ["/home/.local/share/opencode/log", stamp(1, 96, 102)],
      ["/home/.local/share/opencode/log/opencode.log", stamp(1, 10, 103)],
      ["/home/.local/share/opencode/repos", stamp(1, 96, 104)],
      ["/home/.local/state/opencode", stamp(1, 96, 105)],
      ["/home/.opencode/bin/opencode", stamp(1, 10, 106)],
    ]);

    expect(diff(new Map(), after).added).toEqual([
      "/home/.config/opencode",
      "/home/.local/share/opencode",
      "/home/.local/state/opencode",
      "/home/.opencode/bin/opencode",
    ]);
  });

  test("flags an inode change even when mtime and size are unchanged", () => {
    const before = snap([["/home/link", stamp(1, 5, 100)]]);
    const after = snap([["/home/link", stamp(1, 5, 200)]]);

    expect(diff(before, after).edited).toEqual(["/home/link"]);
  });

  test("flags a size change even when mtime is unchanged", () => {
    const before = snap([["/home/file", stamp(1, 5, 100)]]);
    const after = snap([["/home/file", stamp(1, 9, 100)]]);

    expect(diff(before, after).edited).toEqual(["/home/file"]);
  });

  test("does not flag a folder whose contents changed as edited", () => {
    const before = snap([["/home/dir", stamp(1, 96, 100, true)]]);
    const after = snap([["/home/dir", stamp(2, 128, 100, true)]]);

    expect(diff(before, after).edited).toEqual([]);
  });
});
