import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pickExecutable } from "./executable";
import { tmpdir } from "node:os";

const dirs: string[] = [];

function testDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-executable-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pickExecutable", () => {
  test("ignores symlinks to non-executable files, directories, and missing targets", () => {
    const dir = testDir();
    const config = join(dir, "config");
    writeFileSync(config, "config");
    chmodSync(config, 0o600);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    const links = [join(dir, "config-link"), join(dir, "folder-link"), join(dir, "missing-link")];
    symlinkSync(config, links[0]!);
    symlinkSync(folder, links[1]!);
    symlinkSync(join(dir, "missing"), links[2]!);

    for (const link of links) expect(pickExecutable([link])).toBeUndefined();
    expect(pickExecutable([dir])).toBeUndefined();
  });

  test("keeps an executable symlink as the command path", () => {
    const dir = testDir();
    const binary = join(dir, "tool");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const link = join(bin, "tool");
    symlinkSync(binary, link);

    expect(pickExecutable([binary, link])).toBe(link);
  });
});
