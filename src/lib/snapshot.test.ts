import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "./snapshot";
import { tmpdir } from "node:os";

const HOME_BACKUP = process.env.HOME;

afterEach(() => {
  process.env.HOME = HOME_BACKUP;
});

function touch(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

describe("snapshot", () => {
  test("skips cache folders at any depth and shared package-manager state, but keeps tool folders and their logs", () => {
    const home = mkdtempSync(join(tmpdir(), "tret-test-"));
    process.env.HOME = home;
    touch(join(home, ".npm/_cacache/index-v5/entry"));
    touch(join(home, ".npm/_logs/debug.log"));
    touch(join(home, ".mytool/logs/debug.log"));
    touch(join(home, ".mytool/cache/blob"));
    touch(join(home, ".mytool/bin/mytool"));
    touch(join(home, ".cache/other/blob"));

    const keys = [...snapshot().keys()].filter((key) => key.startsWith(`${home}/`));

    expect(keys).toContain(join(home, ".mytool/bin/mytool"));
    expect(keys).toContain(join(home, ".mytool/logs/debug.log"));
    // `~/.npm` is shared npm state every installer's `npm install`/`npm ci` writes, so it is skipped
    // wholesale rather than owned: its cache is not one tool's, and owning the directory would strand
    // a record on the untracked cache at uninstall.
    expect(keys.some((key) => key === join(home, ".npm") || key.startsWith(join(home, ".npm/")))).toBe(false);
    expect(keys.some((key) => key.includes(join(home, ".mytool/cache")))).toBe(false);
    expect(keys.some((key) => key.startsWith(join(home, ".cache")))).toBe(false);
  });
});
