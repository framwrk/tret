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

    const result = removeAdded([join(home, ".local/bin/mytool"), join(home, "tools/mytool")], false);

    expect(result.removed).toHaveLength(2);
    expect(result.kept).toEqual([]);
    expect(existsSync(join(home, ".local/bin/mytool"))).toBe(false);
    expect(existsSync(join(home, "tools/mytool"))).toBe(false);
  });

  test("guards shared and shallow directories but deletes files inside them", () => {
    const home = testHome();
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config/mytool.conf"), "");

    const result = removeAdded([home, join(home, ".config"), join(home, ".config/mytool.conf")], false);

    expect(result.removed).toEqual([join(home, ".config/mytool.conf")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".config"), home]);
    expect(existsSync(join(home, ".config/mytool.conf"))).toBe(false);
  });

  test("counts already-missing paths as removed", () => {
    const home = testHome();

    const result = removeAdded([join(home, "gone")], false);

    expect(result.removed).toEqual([join(home, "gone")]);
    expect(result.kept).toEqual([]);
  });

  test("dry run touches nothing", () => {
    const home = testHome();
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(join(home, ".config/mytool.conf"), "");

    const result = removeAdded([join(home, ".config"), join(home, ".config/mytool.conf")], true);

    expect(result.removed).toEqual([join(home, ".config/mytool.conf")]);
    expect(result.kept.map((kept) => kept.path)).toEqual([join(home, ".config")]);
    expect(existsSync(join(home, ".config/mytool.conf"))).toBe(true);
  });
});
