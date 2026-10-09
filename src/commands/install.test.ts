import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// These are the commands driven end to end, in a throwaway $HOME, through a fixture installer served
// over loopback. They are the coverage whose absence let phase 5/9 ship split-brained: install wrote
// a v2 record and uninstall then removed nothing.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-cli-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** Runs the CLI from source as a child process so its `process.exit` never kills the test runner. */
async function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<number> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, ...extraEnv, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

/** Serves one raw script over loopback; the install URL needs a dotted host and a non-HTML body. */
function serve(script: string): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(script, { headers: { "content-type": "text/plain" } }),
  });
  return { url: `http://127.0.0.1:${server.port}/install.sh`, stop: () => server.stop(true) };
}

const INSTALL_SCRIPT = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/mytool"
printf '#!/bin/sh\\necho mytool\\n' > "$HOME/.local/bin/mytool"
chmod +x "$HOME/.local/bin/mytool"
printf 'setting = 1\\n' > "$HOME/.config/mytool/config"
`;

const FAIL_SCRIPT = `#!/bin/bash
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho boo\\n' > "$HOME/.local/bin/badtool"
chmod +x "$HOME/.local/bin/badtool"
exit 3
`;

// Defect #3: an installer that writes a tool directory and a dotfile directly at `$HOME` (the shape
// of `~/.claude/` + `~/.claude.json`) must be observed and removable.
const HOME_ROOT_SCRIPT = `#!/bin/bash
set -e
printf '#!/bin/sh\\necho hometool\\n' > "$HOME/.toolrc"
mkdir -p "$HOME/.tool/bin"
printf '#!/bin/sh\\necho hometool\\n' > "$HOME/.tool/bin/hometool"
chmod +x "$HOME/.tool/bin/hometool"
`;

// A `bun install -g` shape: a shared global manifest/lockfile/node_modules plus a bin shim. The
// shared global state must not be owned, and the shim must mark the record as a managed package so
// uninstall delegates to the manager instead of deleting state every other global install shares.
const BUN_GLOBAL_SCRIPT = `#!/bin/bash
set -e
mkdir -p "$HOME/.bun/install/global/node_modules/@acme/tool" "$HOME/.bun/bin"
printf '{"dependencies":{"@acme/tool":"^1.0.0"}}\\n' > "$HOME/.bun/install/global/package.json"
printf 'lockfile\\n' > "$HOME/.bun/install/global/bun.lock"
printf '#!/usr/bin/env node\\nconsole.log(1)\\n' > "$HOME/.bun/install/global/node_modules/@acme/tool/cli.js"
chmod +x "$HOME/.bun/install/global/node_modules/@acme/tool/cli.js"
ln -s ../install/global/node_modules/@acme/tool/cli.js "$HOME/.bun/bin/acmetool"
`;

// An `npm install -g --prefix "$HOME/.local"` shape (the fallback the Pi installer uses): the package
// files live under the prefix's `lib/node_modules` (skipped) and the bin shim in the prefix's `bin`.
// Detection must resolve the prefix from the shim and record it, since npm's prefix is not fixed.
const NPM_GLOBAL_SCRIPT = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/lib/node_modules/@acme/tool" "$HOME/.local/bin"
printf '#!/usr/bin/env node\\nconsole.log(1)\\n' > "$HOME/.local/lib/node_modules/@acme/tool/cli.js"
chmod +x "$HOME/.local/lib/node_modules/@acme/tool/cli.js"
ln -s ../lib/node_modules/@acme/tool/cli.js "$HOME/.local/bin/acmetool"
`;

// A first-party managed install (`kind: pi-managed-install`, `layout: releases-v1`): a marker and a
// versioned release tree under `~/.pi/agent/install`, a launcher under `~/.pi/agent/bin/pi`, and a
// `node_modules` payload capture skips. The untracked payload is what stranded the record: every
// ancestor stayed `not-empty` after the wrapper files were removed.
const PI_MANAGED_SCRIPT = `#!/bin/bash
set -e
ROOT="$HOME/.pi/agent/install"
mkdir -p "$ROOT/releases/1.0.0/node_modules/acme" "$HOME/.pi/agent/bin"
printf '{"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}\\n' > "$ROOT/managed-install.json"
printf '1.0.0\\n' > "$ROOT/current-version"
printf '{"name":"pi"}\\n' > "$ROOT/releases/1.0.0/package.json"
printf 'module.exports = 1;\\n' > "$ROOT/releases/1.0.0/node_modules/acme/index.js"
printf '#!/bin/sh\\necho pi\\n' > "$HOME/.pi/agent/bin/pi"
chmod +x "$HOME/.pi/agent/bin/pi"
`;

type StoredRecord = {
  name: string;
  source: string;
  capture: { completeness: string; segments: { kind: string; partialReason?: string }[] };
  owned: { path: string; kind?: string; installedHash?: string }[];
  managedBy?: { manager: string; package: string; globalRoot?: string };
  managedInstall?: { kind: string; layout: string; root: string };
};

function readStore(home: string): { version: number; records: StoredRecord[] } {
  return JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8"));
}

describe("install -> list -> uninstall", () => {
  test("writes a v3 record, lists it, then removes the tool and drops the record", async () => {
    const home = makeHome();
    const server = serve(INSTALL_SCRIPT);
    try {
      const installed = await runCli(["install", server.url], home);
      expect(installed).toBe(0);

      const file = readStore(home);
      expect(file.version).toBe(3);
      const record = file.records.find((entry) => entry.name === "mytool");
      expect(record).toBeDefined();
      expect(record?.source).toBe("install");
      expect(record?.capture.completeness).toBe("heuristic");
      expect(
        record?.owned.some((entry) => entry.path.endsWith("/.local/bin/mytool") && entry.installedHash !== undefined),
      ).toBe(true);

      // `list` reads the v3 store; before phase 9 it threw on any v3 file.
      expect(await runCli(["list"], home)).toBe(0);

      // A dry run plans the removal and touches nothing.
      expect(await runCli(["uninstall", "mytool", "--dry-run"], home)).toBe(0);
      expect(existsSync(join(home, ".local", "bin", "mytool"))).toBe(true);

      expect(await runCli(["uninstall", "mytool", "--yes"], home)).toBe(0);
      expect(existsSync(join(home, ".local", "bin", "mytool"))).toBe(false);

      const after = readStore(home);
      expect(after.version).toBe(3);
      expect(after.records).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  test("--no-capture records through the legacy snapshot fallback as a hash-less v3 record", async () => {
    const home = makeHome();
    const server = serve(INSTALL_SCRIPT);
    try {
      expect(await runCli(["install", server.url, "--no-capture"], home)).toBe(0);

      const file = readStore(home);
      expect(file.version).toBe(3);
      const record = file.records.find((entry) => entry.name === "mytool");
      expect(record).toBeDefined();
      expect(record?.capture.completeness).toBe("heuristic");
      // With no journal there are no fingerprints: uninstall must treat these as unverified.
      expect(record?.owned.every((entry) => entry.installedHash === undefined)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("a failed installer leaves a labeled partial v3 record and exits non-zero (D6)", async () => {
    const home = makeHome();
    const server = serve(FAIL_SCRIPT);
    try {
      expect(await runCli(["install", server.url], home)).not.toBe(0);

      const file = readStore(home);
      expect(file.version).toBe(3);
      const record = file.records.find((entry) => entry.name === "badtool");
      expect(record).toBeDefined();
      expect(record?.capture.completeness).toBe("partial");
      expect(record?.capture.segments[0]?.partialReason).toContain("3");
      expect(record?.owned.some((entry) => entry.path.endsWith("/.local/bin/badtool"))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("captures tool state written at the home root and removes it on uninstall (defect #3)", async () => {
    const home = makeHome();
    const server = serve(HOME_ROOT_SCRIPT);
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const file = readStore(home);
      const record = file.records.find((entry) => entry.name === "hometool");
      expect(record).toBeDefined();
      // The dotfile and the dot-directory at `$HOME` top level are owned, not left uncovered.
      expect(record?.owned.some((entry) => entry.path === join(home, ".toolrc"))).toBe(true);
      expect(record?.owned.some((entry) => entry.path === join(home, ".tool", "bin", "hometool"))).toBe(true);

      expect(await runCli(["uninstall", "hometool", "--yes"], home)).toBe(0);
      expect(existsSync(join(home, ".toolrc"))).toBe(false);
      expect(existsSync(join(home, ".tool", "bin", "hometool"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("does not own shared bun global state and marks the install as a managed package", async () => {
    const home = makeHome();
    // Bun and its shared state already exist; only the global manifest/shim are new, so the parent
    // directories are not owned and only the shim can be recorded.
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(join(home, ".bun", "install"), { recursive: true });
    const server = serve(BUN_GLOBAL_SCRIPT);
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "acmetool");
      expect(record).toBeDefined();
      expect(record?.owned.some((entry) => entry.path === join(home, ".bun", "bin", "acmetool"))).toBe(true);
      // The shared global directory, manifest, and lockfile are never owned.
      const ownedPaths = record?.owned.map((entry) => entry.path) ?? [];
      expect(ownedPaths.some((path) => path.includes(".bun/install/global"))).toBe(false);
      expect(record?.managedBy).toEqual({ manager: "bun", package: "@acme/tool" });
    } finally {
      await server.stop();
    }
  });

  test("recognizes an npm global under a custom prefix and records that prefix", async () => {
    const home = makeHome();
    // The prefix and its `lib` already exist; only the package tree and shim are new, so the shared
    // `lib` directory is not owned.
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, ".local", "lib"), { recursive: true });
    const server = serve(NPM_GLOBAL_SCRIPT);
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "acmetool");
      expect(record).toBeDefined();
      expect(record?.owned.some((entry) => entry.path === join(home, ".local", "bin", "acmetool"))).toBe(true);
      // The shared package tree under the prefix's `lib/node_modules` is never owned.
      const ownedPaths = record?.owned.map((entry) => entry.path) ?? [];
      expect(ownedPaths.some((path) => path.includes("lib/node_modules"))).toBe(false);
      expect(record?.managedBy).toEqual({
        manager: "npm",
        package: "@acme/tool",
        globalRoot: join(home, ".local", "lib"),
      });
    } finally {
      await server.stop();
    }
  });

  test("--force reinstalls a managed npm global without deleting the shared tree", async () => {
    const home = makeHome();
    const prefix = join(home, ".local");
    const shim = join(prefix, "bin", "acmetool");
    const packageDir = join(prefix, "lib", "node_modules", "@acme", "tool");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    symlinkSync("../lib/node_modules/@acme/tool/cli.js", shim);

    // A fake `npm` stands in for the real remove command, which needs network/registry access.
    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeNpm = join(fakebin, "npm");
    writeFileSync(fakeNpm, `#!/bin/sh\nrm -rf "$HOME/.local/lib/node_modules/@acme/tool"\nexit 0\n`);
    chmodSync(fakeNpm, 0o755);

    const server = serve(NPM_GLOBAL_SCRIPT);
    // Seed a managed record for the same URL so `--force` exercises the reinstall path.
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(
      join(home, ".tret", "records.json"),
      JSON.stringify({
        version: 3,
        records: [
          {
            id: "rec-1",
            name: "acmetool",
            source: "install",
            url: server.url,
            installedAt: "2026-10-09T00:00:00.000Z",
            executable: shim,
            scriptSha256: "a".repeat(64),
            capture: {
              backend: "macos-heuristic",
              completeness: "heuristic",
              segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
            },
            privilege: "user",
            caseSensitive: true,
            owned: [{ path: shim, kind: "symlink", linkTarget: "../lib/node_modules/@acme/tool/cli.js" }],
            mutated: [],
            deleted: [],
            managedBy: { manager: "npm", package: "@acme/tool", globalRoot: join(prefix, "lib") },
          },
        ],
      }),
    );

    try {
      const path = `${fakebin}:${process.env.PATH ?? ""}`;
      expect(await runCli(["install", server.url, "--force"], home, { PATH: path })).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "acmetool");
      expect(record).toBeDefined();
      expect(record?.managedBy).toEqual({
        manager: "npm",
        package: "@acme/tool",
        globalRoot: join(prefix, "lib"),
      });
      expect(record?.owned.some((entry) => entry.path.includes("lib/node_modules"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("recognizes a pi managed install, never owns the payload, and delegates its removal", async () => {
    const home = makeHome();
    const server = serve(PI_MANAGED_SCRIPT);
    const root = join(home, ".pi", "agent", "install");
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "pi");
      expect(record).toBeDefined();
      expect(record?.managedInstall).toEqual({ kind: "pi-managed-install", layout: "releases-v1", root });
      // The launcher outside the root stays owned; nothing at or under the root is.
      const ownedPaths = record?.owned.map((entry) => entry.path) ?? [];
      expect(ownedPaths).toContain(join(home, ".pi", "agent", "bin", "pi"));
      expect(ownedPaths.some((path) => path === root || path.startsWith(`${root}/`))).toBe(false);

      expect(await runCli(["list"], home)).toBe(0);

      // A dry run plans the delegated removal and touches nothing.
      expect(await runCli(["uninstall", "pi", "--dry-run"], home)).toBe(0);
      expect(existsSync(join(root, "releases", "1.0.0", "node_modules"))).toBe(true);

      expect(await runCli(["uninstall", "pi", "--yes"], home)).toBe(0);
      // The managed tree, including the payload capture never owned, is gone; the record drops.
      expect(existsSync(join(home, ".pi"))).toBe(false);
      expect(readStore(home).records).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  test("--force reinstalls a managed install by clearing the previous root first", async () => {
    const home = makeHome();
    const server = serve(PI_MANAGED_SCRIPT);
    const stale = join(home, ".pi", "agent", "install", "releases", "1.0.0", "stale.txt");
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);
      // A file inside the old root the installer will not recreate: only the delegated removal clears it.
      writeFileSync(stale, "stale");

      expect(await runCli(["install", server.url, "--force"], home)).toBe(0);
      expect(existsSync(stale)).toBe(false);
      const records = readStore(home).records;
      expect(records).toHaveLength(1);
      expect(records[0]?.managedInstall).toEqual({
        kind: "pi-managed-install",
        layout: "releases-v1",
        root: join(home, ".pi", "agent", "install"),
      });
    } finally {
      await server.stop();
    }
  });
});

describe("managed install removal failure", () => {
  test("a delegated removal that cannot clear the root keeps the record for a retry", async () => {
    const home = makeHome();
    const server = serve(PI_MANAGED_SCRIPT);
    const root = join(home, ".pi", "agent", "install");
    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeRm = join(fakebin, "rm");
    writeFileSync(fakeRm, `#!/bin/sh\necho 'rm denied' >&2\nexit 1\n`);
    chmodSync(fakeRm, 0o755);
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const path = `${fakebin}:${process.env.PATH ?? ""}`;
      expect(await runCli(["uninstall", "pi", "--yes"], home, { PATH: path })).not.toBe(0);

      // The failed delegation left everything untouched and the record in place for a retry.
      expect(existsSync(join(root, "releases", "1.0.0", "node_modules"))).toBe(true);
      expect(existsSync(join(home, ".pi", "agent", "bin", "pi"))).toBe(true);
      const records = readStore(home).records;
      expect(records).toHaveLength(1);
      expect(records[0]?.managedInstall).toBeDefined();
    } finally {
      await server.stop();
    }
  });
});
