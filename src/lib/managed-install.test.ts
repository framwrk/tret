import { afterAll, describe, expect, test } from "bun:test";
import {
  describeManagedInstall,
  detectManagedInstall,
  isManagedInstallPath,
  withoutManagedInstallPaths,
} from "./managed-install";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { OwnedEntry } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tret-managed-"));
  homes.push(home);
  return home;
}

/** A pi managed install on disk: launcher under `<agent>/bin`, marker under `<agent>/install`. */
function piManagedHome(home: string): { launcher: string; root: string; marker: string } {
  const root = join(home, ".pi", "agent", "install");
  const launcher = join(home, ".pi", "agent", "bin", "pi");
  mkdirSync(join(root, "releases", "1.0.0", "node_modules", "acme"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent", "bin"), { recursive: true });
  writeFileSync(join(root, "managed-install.json"), JSON.stringify(piMarker()));
  writeFileSync(join(root, "current-version"), "1.0.0\n");
  writeFileSync(join(root, "releases", "1.0.0", "node_modules", "acme", "index.js"), "module.exports = 1;\n");
  writeFileSync(launcher, "#!/bin/sh\nexec pi\n");
  return { launcher, root, marker: join(root, "managed-install.json") };
}

function piMarker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1", ...overrides };
}

describe("detectManagedInstall", () => {
  test("recognizes the launcher directly and returns the sibling install root", () => {
    const home = testHome();
    const { launcher, root } = piManagedHome(home);

    expect(detectManagedInstall(launcher)).toEqual({ kind: "pi-managed-install", layout: "releases-v1", root });
  });

  test("resolves a recorded PATH entrypoint symlink to the launcher and its root", () => {
    const home = testHome();
    const { launcher, root } = piManagedHome(home);
    const entrypoint = join(home, ".local", "bin", "pi");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(launcher, entrypoint);
    const owned: OwnedEntry[] = [{ path: entrypoint, kind: "symlink", linkTarget: launcher }];

    expect(detectManagedInstall(entrypoint, owned)).toEqual({ kind: "pi-managed-install", layout: "releases-v1", root });
  });

  test("follows an on-disk symlink when the record has no matching entry", () => {
    const home = testHome();
    const { launcher, root } = piManagedHome(home);
    const entrypoint = join(home, ".local", "bin", "pi");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(launcher, entrypoint);

    expect(detectManagedInstall(entrypoint, [])).toEqual({ kind: "pi-managed-install", layout: "releases-v1", root });
  });

  test("ignores a launcher whose marker is missing or does not match the layout", () => {
    const home = testHome();
    const { launcher, marker } = piManagedHome(home);

    rmSync(marker);
    expect(detectManagedInstall(launcher)).toBeUndefined();

    writeFileSync(marker, JSON.stringify(piMarker({ kind: "other-managed-install" })));
    expect(detectManagedInstall(launcher)).toBeUndefined();

    writeFileSync(marker, JSON.stringify(piMarker({ schemaVersion: 2 })));
    expect(detectManagedInstall(launcher)).toBeUndefined();

    writeFileSync(marker, JSON.stringify(piMarker({ layout: "releases-v2" })));
    expect(detectManagedInstall(launcher)).toBeUndefined();
  });

  test("ignores a normal binary and an empty executable", () => {
    const home = testHome();
    const normal = join(home, ".local", "bin", "mytool");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(normal, "#!/bin/sh\n");

    expect(detectManagedInstall(normal)).toBeUndefined();
    expect(detectManagedInstall("")).toBeUndefined();
  });

  test("ignores a marker in a home or shared directory that is not the layout's root", () => {
    const home = testHome();
    const launcher = join(home, "pi");
    writeFileSync(join(home, "managed-install.json"), JSON.stringify(piMarker()));
    writeFileSync(launcher, "#!/bin/sh\nexec pi\n");

    expect(detectManagedInstall(launcher)).toBeUndefined();
  });
});

describe("managed install paths", () => {
  test("matches the root and its subtree but not a launcher outside it", () => {
    const root = "/home/.pi/agent/install";
    const managed = { kind: "pi-managed-install", layout: "releases-v1", root };

    expect(isManagedInstallPath(root, managed)).toBe(true);
    expect(isManagedInstallPath(join(root, "releases", "1.0.0", "node_modules"), managed)).toBe(true);
    expect(isManagedInstallPath("/home/.pi/agent/bin/pi", managed)).toBe(false);
    // A path that merely shares a prefix must not match.
    expect(isManagedInstallPath(`${root}-backup`, managed)).toBe(false);
  });

  test("drops the root subtree and keeps the launcher and ancestors", () => {
    const root = "/home/.pi/agent/install";
    const managed = { kind: "pi-managed-install", layout: "releases-v1", root };
    const entries = [
      { path: "/home/.pi" },
      { path: "/home/.pi/agent" },
      { path: "/home/.pi/agent/bin/pi" },
      { path: root },
      { path: join(root, "managed-install.json") },
      { path: join(root, "releases", "1.0.0") },
    ];

    expect(withoutManagedInstallPaths(entries, managed).map((entry) => entry.path)).toEqual([
      "/home/.pi",
      "/home/.pi/agent",
      "/home/.pi/agent/bin/pi",
    ]);
  });
});

describe("describeManagedInstall", () => {
  test("names the layout and root", () => {
    expect(describeManagedInstall({ kind: "pi-managed-install", layout: "releases-v1", root: "/home/.pi/agent/install" })).toBe(
      "pi-managed-install at /home/.pi/agent/install",
    );
  });
});
