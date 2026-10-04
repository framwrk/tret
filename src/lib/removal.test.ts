import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeAdded } from "./removal";
import { tmpdir } from "node:os";

const HOME_BACKUP = process.env.HOME;

afterEach(() => {
  process.env.HOME = HOME_BACKUP;
});

function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tret-test-"));
  process.env.HOME = home;
  return home;
}

describe("removal", () => {
  test("deletes recorded files and folders", () => {
    const home = testHome();
    mkdirSync(join(home, "tools/mytool"), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/mytool"), "#!/bin/sh\n");

    const result = removeAdded([join(home, ".local/bin/mytool"), join(home, "tools/mytool")], "mytool", false);

    expect(result.removed).toHaveLength(2);
    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(existsSync(join(home, ".local/bin/mytool"))).toBe(false);
    expect(existsSync(join(home, "tools/mytool"))).toBe(false);
  });

  test("guards shared and shallow directories but deletes files inside them", () => {
    const home = testHome();
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config/mytool.conf"), "");

    const result = removeAdded([home, join(home, ".config"), join(home, ".config/mytool.conf")], "mytool", false);

    // The file goes, which empties .config and then home, so both rmdir too: nothing of anyone's is lost.
    expect(result.removed).toEqual([join(home, ".config/mytool.conf"), join(home, ".config"), home]);
    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(existsSync(join(home, ".config/mytool.conf"))).toBe(false);
  });

  test("prunes the tool's entries out of a guarded directory and removes it when empty", () => {
    const home = testHome();
    mkdirSync(join(home, ".cache/opencode"), { recursive: true });
    writeFileSync(join(home, ".cache/opencode/data"), "");

    const result = removeAdded([join(home, ".cache")], "opencode", false);

    expect(result.pruned).toEqual([join(home, ".cache/opencode")]);
    expect(result.removed).toEqual([join(home, ".cache")]);
    expect(existsSync(join(home, ".cache/opencode"))).toBe(false);
    expect(existsSync(join(home, ".cache"))).toBe(false);
  });

  test("prunes tool entries nested below a guarded directory", () => {
    const home = testHome();
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(home, ".local/state/opencode"), { recursive: true });

    const result = removeAdded([join(home, ".local")], "opencode", false);

    expect(result.pruned).toEqual([join(home, ".local/share/opencode"), join(home, ".local/state/opencode")]);
    expect(result.removed).toEqual([join(home, ".local")]);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("keeps a guarded directory that still holds other programs' entries", () => {
    const home = testHome();
    mkdirSync(join(home, ".cache/opencode"), { recursive: true });
    mkdirSync(join(home, ".cache/bun"), { recursive: true });
    writeFileSync(join(home, ".cache/bun/contents"), "");

    const result = removeAdded([join(home, ".cache")], "opencode", false);

    expect(result.pruned).toEqual([join(home, ".cache/opencode")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".cache")]);
    expect(existsSync(join(home, ".cache/opencode"))).toBe(false);
    expect(existsSync(join(home, ".cache/bun/contents"))).toBe(true);
  });

  test("dry run reports prunes without deleting", () => {
    const home = testHome();
    mkdirSync(join(home, ".cache/opencode"), { recursive: true });
    mkdirSync(join(home, ".cache/bun"), { recursive: true });
    writeFileSync(join(home, ".cache/bun/contents"), "");

    const result = removeAdded([join(home, ".cache")], "opencode", true);

    expect(result.pruned).toEqual([join(home, ".cache/opencode")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".cache")]);
    expect(existsSync(join(home, ".cache/opencode"))).toBe(true);
  });

  test("counts already-missing paths as removed", () => {
    const home = testHome();

    const result = removeAdded([join(home, "gone")], "mytool", false);

    expect(result.removed).toEqual([join(home, "gone")]);
    expect(result.kept).toEqual([]);
  });

  test("dry run touches nothing", () => {
    const home = testHome();
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config/mytool.conf"), "");

    const result = removeAdded([join(home, ".config"), join(home, ".config/mytool.conf")], "mytool", true);

    expect(result.removed).toEqual([join(home, ".config/mytool.conf")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".config")]);
    expect(existsSync(join(home, ".config/mytool.conf"))).toBe(true);
  });
});
