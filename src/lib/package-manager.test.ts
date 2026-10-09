import { afterAll, describe, expect, test } from "bun:test";
import {
  describeManagedPackage,
  detectManagedPackage,
  isManagedGlobalPath,
  managedGlobalRoot,
  removeManagedPackage,
} from "./package-manager";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import type { OwnedEntry } from "../types";
import type { PackageCommandRunner } from "./package-manager";
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

describe("removeManagedPackage", () => {
  const pkg = { manager: "bun", package: "@acme/tool" } as const;

  function packageDir(home: string): string {
    return join(home, ".bun", "install", "global", "node_modules", "@acme", "tool");
  }

  test("is a skipped no-op when the package is already absent", async () => {
    const home = testHome();
    let called = false;
    const runner: PackageCommandRunner = async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    };

    const removal = await removeManagedPackage(pkg, { home, runner });
    expect(removal.ok).toBe(true);
    expect(removal.skipped).toBe(true);
    expect(called).toBe(false);
  });

  test("invokes the manager's remove command and reports success on a zero exit", async () => {
    const home = testHome();
    mkdirSync(packageDir(home), { recursive: true });
    const calls: { command: string; args: string[] }[] = [];
    const runner: PackageCommandRunner = async (command, args) => {
      calls.push({ command, args });
      rmSync(packageDir(home), { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    };

    const removal = await removeManagedPackage(pkg, { home, runner });
    expect(removal).toEqual({ ok: true, skipped: false, detail: "bun removed @acme/tool" });
    expect(calls).toEqual([{ command: "bun", args: ["remove", "-g", "@acme/tool"] }]);
  });

  test("accepts a non-zero exit when the package directory is gone afterwards", async () => {
    const home = testHome();
    mkdirSync(packageDir(home), { recursive: true });
    const runner: PackageCommandRunner = async () => {
      rmSync(packageDir(home), { recursive: true, force: true });
      return { code: 1, stdout: "", stderr: "boom" };
    };

    const removal = await removeManagedPackage(pkg, { home, runner });
    expect(removal.ok).toBe(true);
    expect(removal.detail).toContain("is gone");
  });

  test("keeps the failure actionable when the manager fails and the package remains", async () => {
    const home = testHome();
    mkdirSync(packageDir(home), { recursive: true });
    const runner: PackageCommandRunner = async () => ({ code: 2, stdout: "", stderr: "network down\nmore" });

    const removal = await removeManagedPackage(pkg, { home, runner });
    expect(removal.ok).toBe(false);
    expect(removal.detail).toContain("network down");
  });

  test("reports a throw from the runner instead of crashing", async () => {
    const home = testHome();
    mkdirSync(packageDir(home), { recursive: true });
    const runner: PackageCommandRunner = async () => {
      throw new Error("spawn ENOENT");
    };

    const removal = await removeManagedPackage(pkg, { home, runner });
    expect(removal.ok).toBe(false);
    expect(removal.detail).toContain("spawn ENOENT");
  });
});

describe("managed global state", () => {
  test("locates the shared root and matches paths at or under it", () => {
    const home = testHome();
    const pkg = { manager: "bun", package: "@acme/tool" } as const;
    const root = join(home, ".bun", "install", "global");

    expect(managedGlobalRoot(pkg, home)).toBe(root);
    expect(isManagedGlobalPath(root, pkg, home)).toBe(true);
    expect(isManagedGlobalPath(join(root, "package.json"), pkg, home)).toBe(true);
    expect(isManagedGlobalPath(join(home, ".bun", "bin", "acmetool"), pkg, home)).toBe(false);
  });
});

describe("describeManagedPackage", () => {
  test("names the package and manager", () => {
    expect(describeManagedPackage({ manager: "bun", package: "@acme/tool" })).toBe("@acme/tool (bun global)");
  });
});
