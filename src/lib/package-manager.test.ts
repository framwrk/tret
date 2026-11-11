import { afterAll, describe, expect, test } from "bun:test";
import {
  describeManagedPackage,
  detectManagedPackage,
  isManagedGlobalPath,
  managedGlobalRoot,
  managedPackageRemovalScope,
} from "./package-manager";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import type { OwnedEntry } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tret-pkg-"));
  homes.push(home);
  return home;
}

describe("detectManagedPackage", () => {
  test("recognizes a scoped bun global from the recorded shim symlink", () => {
    const home = testHome();
    const executable = join(home, ".bun", "bin", "omp");
    const owned: OwnedEntry[] = [
      {
        path: executable,
        kind: "symlink",
        linkTarget: "../install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
      },
    ];

    expect(detectManagedPackage(executable, owned, home)).toEqual({
      manager: "bun",
      package: "@oh-my-pi/pi-coding-agent",
    });
  });

  test("recognizes an unscoped npm global from the recorded shim symlink", () => {
    const home = testHome();
    const executable = join(home, ".npm-global", "bin", "eslint");
    const owned: OwnedEntry[] = [{ path: executable, kind: "symlink", linkTarget: "../lib/node_modules/eslint/bin/eslint.js" }];

    expect(detectManagedPackage(executable, owned, home)).toEqual({ manager: "npm", package: "eslint" });
  });

  test("recognizes an npm global under a custom prefix and records the prefix's shared root", () => {
    const home = testHome();
    const executable = join(home, ".local", "bin", "pi");
    const owned: OwnedEntry[] = [
      { path: executable, kind: "symlink", linkTarget: "../lib/node_modules/@acme/tool/dist/cli.js" },
    ];

    expect(detectManagedPackage(executable, owned, home)).toEqual({
      manager: "npm",
      package: "@acme/tool",
      globalRoot: join(home, ".local", "lib"),
    });
  });

  test("ignores a shim whose target names node_modules but sits outside the prefix", () => {
    const home = testHome();
    const executable = join(home, "bin", "tool");
    const owned: OwnedEntry[] = [
      { path: executable, kind: "symlink", linkTarget: `${home}/.local/lib/node_modules/@acme/tool/cli.js` },
    ];

    expect(detectManagedPackage(executable, owned, home)).toBeUndefined();
  });

  test("falls back to the symlink on disk when the record has no matching entry", () => {
    const home = testHome();
    mkdirSync(join(home, ".bun", "install", "global", "node_modules", "acme"), { recursive: true });
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    const executable = join(home, ".bun", "bin", "acme");
    symlinkSync("../install/global/node_modules/acme/cli.js", executable);

    expect(detectManagedPackage(executable, [], home)).toEqual({ manager: "bun", package: "acme" });
  });

  test("ignores a normal binary and an empty executable", () => {
    const home = testHome();
    expect(detectManagedPackage(join(home, ".local", "bin", "mytool"), [], home)).toBeUndefined();
    expect(detectManagedPackage("", [], home)).toBeUndefined();
  });
});

describe("managed global state", () => {
  test("locates the shared root and matches paths at or under it", () => {
    const home = testHome();
    const pkg = { manager: "bun", package: "@acme/tool" } as const;
    const root = join(home, ".bun", "install", "global");

    expect(managedGlobalRoot(pkg, home)).toBe(root);
    expect(managedPackageRemovalScope(pkg, home)).toBe(join(root, "node_modules", "@acme", "tool"));
    expect(isManagedGlobalPath(root, pkg, home)).toBe(true);
    expect(isManagedGlobalPath(join(root, "package.json"), pkg, home)).toBe(true);
    expect(isManagedGlobalPath(join(home, ".bun", "bin", "acmetool"), pkg, home)).toBe(false);
  });

  test("prefers a recorded npm prefix over the home-relative default", () => {
    const home = testHome();
    const root = join(home, ".local", "lib");
    const pkg = { manager: "npm", package: "@acme/tool", globalRoot: root } as const;

    expect(managedGlobalRoot(pkg, home)).toBe(root);
    expect(isManagedGlobalPath(join(root, "node_modules"), pkg, home)).toBe(true);
    // The shim lives in the prefix's `bin`, not the shared `lib` tree, so it stays owned.
    expect(isManagedGlobalPath(join(home, ".local", "bin", "acmetool"), pkg, home)).toBe(false);
  });
});

describe("describeManagedPackage", () => {
  test("names the package and manager", () => {
    expect(describeManagedPackage({ manager: "bun", package: "@acme/tool" })).toBe("@acme/tool (bun global)");
  });
});
