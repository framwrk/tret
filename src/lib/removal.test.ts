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
    mkdirSync(join(home, ".cache/mytool"), { recursive: true });
    writeFileSync(join(home, ".cache/mytool/data"), "");

    const result = removeAdded([join(home, ".cache")], "mytool", false);

    expect(result.pruned).toEqual([join(home, ".cache/mytool")]);
    expect(result.removed).toEqual([join(home, ".cache")]);
    expect(existsSync(join(home, ".cache/mytool"))).toBe(false);
    expect(existsSync(join(home, ".cache"))).toBe(false);
  });

  test("removes the empty shared folders an install created, never their non-empty ones", () => {
    const home = testHome();
    mkdirSync(join(home, ".local/share/mytool"), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/share/mytool/data"), "");
    writeFileSync(join(home, ".local/bin/mytool"), "#!/bin/sh\n");

    const result = removeAdded([join(home, ".local/bin/mytool"), join(home, ".local/share/mytool")], "mytool", false);

    expect(result.removed).toHaveLength(2);
    expect(result.kept).toEqual([]);
    expect(existsSync(join(home, ".local/share"))).toBe(false);
    expect(existsSync(join(home, ".local/bin"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("keeps a shared folder that still holds another tool's files", () => {
    const home = testHome();
    mkdirSync(join(home, ".local/share/mytool"), { recursive: true });
    mkdirSync(join(home, ".local/share/other"), { recursive: true });
    writeFileSync(join(home, ".local/share/other/data"), "");

    const result = removeAdded([join(home, ".local/share/mytool")], "mytool", false);

    expect(result.removed).toHaveLength(1);
    expect(existsSync(join(home, ".local/share"))).toBe(true);
    expect(existsSync(join(home, ".local/share/other/data"))).toBe(true);
  });

  test("prunes tool entries nested below a guarded directory", () => {
    const home = testHome();
    mkdirSync(join(home, ".local/share/mytool"), { recursive: true });
    mkdirSync(join(home, ".local/state/mytool"), { recursive: true });

    const result = removeAdded([join(home, ".local")], "mytool", false);

    expect(result.pruned).toEqual([join(home, ".local/share/mytool"), join(home, ".local/state/mytool")]);
    expect(result.removed).toEqual([join(home, ".local")]);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("keeps a guarded directory that still holds other programs' entries", () => {
    const home = testHome();
    mkdirSync(join(home, ".cache/mytool"), { recursive: true });
    mkdirSync(join(home, ".cache/bun"), { recursive: true });
    writeFileSync(join(home, ".cache/bun/contents"), "");

    const result = removeAdded([join(home, ".cache")], "mytool", false);

    expect(result.pruned).toEqual([join(home, ".cache/mytool")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".cache")]);
    expect(existsSync(join(home, ".cache/mytool"))).toBe(false);
    expect(existsSync(join(home, ".cache/bun/contents"))).toBe(true);
  });

  test("dry run reports prunes without deleting", () => {
    const home = testHome();
    mkdirSync(join(home, ".cache/mytool"), { recursive: true });
    mkdirSync(join(home, ".cache/bun"), { recursive: true });
    writeFileSync(join(home, ".cache/bun/contents"), "");

    const result = removeAdded([join(home, ".cache")], "mytool", true);

    expect(result.pruned).toEqual([join(home, ".cache/mytool")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".cache")]);
    expect(existsSync(join(home, ".cache/mytool"))).toBe(true);
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
