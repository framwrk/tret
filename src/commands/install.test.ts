import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

type StoredRecord = {
  name: string;
  source: string;
  capture: { completeness: string; segments: { kind: string; partialReason?: string }[] };
  owned: { path: string; kind?: string; installedHash?: string }[];
  managedBy?: { manager: string; package: string };
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
});
