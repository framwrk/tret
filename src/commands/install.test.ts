import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { heuristicFallbackRoots, parseObserveFlags } from "./install";
import { isRoot, parentAttachRestricted } from "../lib/capture/linux/backend";
import { join } from "node:path";
import { tmpdir } from "node:os";

// These are the commands driven end to end, in a throwaway $HOME, through a fixture installer served
// over loopback. They are the coverage whose absence let phase 5/9 ship split-brained: install wrote
// a v2 record and uninstall then removed nothing.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

/**
 * Whether an install here gets the real Linux window instead of the heuristic fallback: Linux with
 * strace present and a kernel that lets an unprivileged tracer attach to its parent (Yama
 * `ptrace_scope >= 1` — the stock Ubuntu/CI setting — forbids it). A real window proves the install
 * (`complete`); the fallback only observes it (`heuristic`).
 */
const REAL_CAPTURE = process.platform === "linux" && Bun.which("strace") !== null && (isRoot() || !parentAttachRestricted());

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-cli-"));
  homes.push(dir);
  return dir;
}

function writeRecords(home: string, records: unknown[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
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

/** Runs the CLI and keeps its output, for assertions on what Tret told the user. */
async function runCliResult(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, ...extraEnv, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Serves one raw script over loopback; the install URL needs a dotted host and a non-HTML body. */
function serve(script: string): { url: string; stop: () => Promise<void> } {
  return serveResponses({ body: script });
}

function serveResponses(...responses: { body: string; status?: number; contentType?: string }[]): {
  url: string;
  stop: () => Promise<void>;
} {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      const response = responses[Math.min(requestCount++, responses.length - 1)]!;
      return new Response(response.body, {
        status: response.status ?? 200,
        headers: { "content-type": response.contentType ?? "text/plain" },
      });
    },
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

const FORCE_FAIL_SCRIPT = `#!/bin/bash
set -e
if [ -e "$HOME/.local/bin/mytool" ]; then exit 99; fi
mkdir -p "$HOME/.local/bin" "$HOME/.config/mytool"
printf '#!/bin/sh\\necho replacement\\n' > "$HOME/.local/bin/mytool"
chmod +x "$HOME/.local/bin/mytool"
printf 'replacement config\\n' > "$HOME/.config/mytool/config"
exit 7
`;

const FORCE_NO_EXECUTABLE_SCRIPT = `#!/bin/bash
set -e
if [ -e "$HOME/.local/bin/mytool" ]; then exit 99; fi
mkdir -p "$HOME/.config/mytool"
printf 'recovery data\\n' > "$HOME/.config/mytool/recovery.txt"
exit 9
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

// A tool whose state lives outside every default capture root (the test passes its temp directory
// via `--observe`) plus a normal executable, so the install itself succeeds without the flag too.
function outsideScopeScript(extra: string): string {
  return `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho observetool\\n' > "$HOME/.local/bin/observetool"
chmod +x "$HOME/.local/bin/observetool"
printf 'state\\n' > '${extra}/state.txt'
`;
}

// A dotfile directly under `$HOME` (covered only by the home root) plus an executable under the
// curated `.local/bin` root, so excluding `$HOME` still leaves something to observe.
const HOME_TOP_LEVEL_SCRIPT = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho observetool\\n' > "$HOME/.local/bin/observetool"
chmod +x "$HOME/.local/bin/observetool"
printf 'rc\\n' > "$HOME/.observetoolrc"
`;

type StoredRecord = {
  id: string;
  name: string;
  source: string;
  executable: string;
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
      expect(record?.capture.completeness).toBe(REAL_CAPTURE ? "complete" : "heuristic");
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

  test("--force keeps the current install and record when the replacement download fails", async () => {
    const home = makeHome();
    const server = serveResponses(
      { body: INSTALL_SCRIPT },
      { body: "<!doctype html><html>unavailable</html>", status: 503, contentType: "text/html" },
    );
    const executable = join(home, ".local", "bin", "mytool");
    const config = join(home, ".config", "mytool", "config");
    const recordsPath = join(home, ".tret", "records.json");
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);
      const previousRecords = readFileSync(recordsPath, "utf8");

      expect(await runCli(["install", server.url, "--force"], home)).not.toBe(0);

      expect(existsSync(executable)).toBe(true);
      expect(readFileSync(executable, "utf8")).toContain("echo mytool");
      expect(readFileSync(config, "utf8")).toBe("setting = 1\n");
      expect(readFileSync(recordsPath, "utf8")).toBe(previousRecords);
    } finally {
      await server.stop();
    }
  });

  test("--force keeps a partial record for a downloaded replacement that exits non-zero", async () => {
    const home = makeHome();
    const server = serveResponses({ body: INSTALL_SCRIPT }, { body: FORCE_FAIL_SCRIPT });
    const executable = join(home, ".local", "bin", "mytool");
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      expect(await runCli(["install", server.url, "--force"], home)).not.toBe(0);

      expect(readFileSync(executable, "utf8")).toContain("echo replacement");
      const records = readStore(home).records;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ name: "mytool", executable, capture: { completeness: "partial" } });
      expect(records[0]?.capture.segments[0]?.partialReason).toContain("7");
      expect(records[0]?.owned.some((entry) => entry.path === executable)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("--force records and allows removal of changes when the replacement adds no executable", async () => {
    const home = makeHome();
    const server = serveResponses({ body: INSTALL_SCRIPT }, { body: FORCE_NO_EXECUTABLE_SCRIPT });
    const executable = join(home, ".local", "bin", "mytool");
    const recoveryPath = join(home, ".config", "mytool", "recovery.txt");
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      expect(await runCli(["install", server.url, "--force"], home)).not.toBe(0);

      expect(existsSync(executable)).toBe(false);
      expect(readFileSync(recoveryPath, "utf8")).toBe("recovery data\n");
      const records = readStore(home).records;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ name: "mytool", executable: "", capture: { completeness: "partial" } });
      expect(records[0]?.capture.segments[0]?.partialReason).toContain("9");
      expect(records[0]?.capture.segments[0]?.partialReason).toContain("no executable command");
      expect(records[0]?.owned.some((entry) => entry.path === recoveryPath)).toBe(true);

      expect(await runCli(["list"], home)).toBe(0);
      expect(await runCli(["uninstall", "mytool", "--yes"], home)).toBe(0);
      expect(existsSync(recoveryPath)).toBe(false);
      expect(readStore(home).records).toHaveLength(0);
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

  test("--force does not delegate removal of a managed package with another record's descendant claim", async () => {
    const home = makeHome();
    const prefix = join(home, ".local");
    const shim = join(prefix, "bin", "acmetool");
    const packageDir = join(prefix, "lib", "node_modules", "@acme", "tool");
    const claimedPath = join(packageDir, "nested", "owned.txt");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(packageDir, "nested"), { recursive: true });
    symlinkSync("../lib/node_modules/@acme/tool/cli.js", shim);
    writeFileSync(join(packageDir, "cli.js"), "#!/bin/sh\n");
    writeFileSync(claimedPath, "owned by another tool");

    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeNpm = join(fakebin, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nprintf '%s\\n' called > "$HOME/fake-npm-called"\nrm -rf "$HOME/.local/lib/node_modules/@acme/tool"\nexit 0\n`,
    );
    chmodSync(fakeNpm, 0o755);

    const server = serve(NPM_GLOBAL_SCRIPT);
    writeRecords(home, [
      {
        id: "rec-managed",
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
      {
        id: "rec-other",
        name: "other-tool",
        source: "install",
        url: "https://example.com/other.sh",
        installedAt: "2026-10-09T00:00:00.000Z",
        executable: claimedPath,
        scriptSha256: "b".repeat(64),
        capture: {
          backend: "macos-heuristic",
          completeness: "heuristic",
          segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
        },
        privilege: "user",
        caseSensitive: true,
        owned: [{ path: claimedPath, kind: "file" }],
        mutated: [],
        deleted: [],
      },
    ]);

    try {
      const path = `${fakebin}:${process.env.PATH ?? ""}`;
      expect(await runCli(["install", server.url, "--force"], home, { PATH: path })).not.toBe(0);

      expect(existsSync(join(home, "fake-npm-called"))).toBe(false);
      expect(existsSync(packageDir)).toBe(true);
      expect(existsSync(claimedPath)).toBe(true);
      expect(existsSync(shim)).toBe(true);
      expect(readStore(home).records.map((entry) => entry.id)).toEqual(["rec-managed", "rec-other"]);
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

  test("--force plans the previous install's removal with its capture's evidence label", async () => {
    const home = makeHome();
    const server = serveResponses({ body: INSTALL_SCRIPT }, { body: INSTALL_SCRIPT });
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const result = await runCliResult(["install", server.url, "--force"], home);

      expect(result.code).toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("reinstalling mytool: removing the previous install first");
      const binary = join(home, ".local", "bin", "mytool");
      if (REAL_CAPTURE) {
        // A real window proves the previous install, so the same plan carries no caveat.
        expect(output).not.toContain("observed, not proven");
        expect(output).toContain(`remove ${binary}`);
      } else {
        // The previous record's evidence is heuristic, so its planned removal is labeled up front.
        expect(output).toContain("note: these paths are observed, not proven to belong to this tool");
        expect(output).toContain(`remove ${binary} (observed, not proven)`);
      }
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

describe("capture scope flags", () => {
  test("parseObserveFlags extracts scope flags and leaves the command alone", () => {
    expect(
      parseObserveFlags([
        "curl",
        "-fsSL",
        "https://example.com/install.sh",
        "--observe",
        "/srv/a",
        "--observe",
        "/srv/b/",
        "--observe-exclude",
        "/usr/local/bin",
      ]),
    ).toEqual({
      // The trailing slash is canonicalized so the root itself stays covered.
      scope: { include: ["/srv/a", "/srv/b"], exclude: ["/usr/local/bin"] },
      rest: ["curl", "-fsSL", "https://example.com/install.sh"],
    });
  });

  test("parseObserveFlags rejects a missing or relative path", () => {
    expect(parseObserveFlags(["--observe"])).toEqual({ error: "--observe requires an absolute path" });
    expect(parseObserveFlags(["--observe-exclude", "var/log"])).toEqual({
      error: "--observe-exclude requires an absolute path: var/log",
    });
  });

  test("the heuristic fallback trims the unbounded trees and never re-adds $HOME", () => {
    expect(heuristicFallbackRoots(["/opt", "/usr/bin", "/usr/local/bin"])).toEqual(["/usr/local/bin"]);
  });

  test("--observe adds a root so a write outside the defaults is owned", async () => {
    const home = makeHome();
    const extra = mkdtempSync(join(tmpdir(), "tret-observe-"));
    homes.push(extra);
    const server = serve(outsideScopeScript(extra));
    try {
      expect(await runCli(["install", server.url, "--observe", extra], home)).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "observetool");
      expect(record).toBeDefined();
      expect(record?.owned.some((entry) => entry.path === join(extra, "state.txt"))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("a write outside the defaults is not owned without --observe", async () => {
    const home = makeHome();
    const extra = mkdtempSync(join(tmpdir(), "tret-observe-"));
    homes.push(extra);
    const server = serve(outsideScopeScript(extra));
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "observetool");
      expect(record).toBeDefined();
      expect(record?.owned.some((entry) => entry.path === join(extra, "state.txt"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("--observe-exclude drops a default root for this one install", async () => {
    const home = makeHome();
    const server = serve(HOME_TOP_LEVEL_SCRIPT);
    try {
      expect(await runCli(["install", server.url, "--observe-exclude", home], home)).toBe(0);

      const record = readStore(home).records.find((entry) => entry.name === "observetool");
      expect(record).toBeDefined();
      // The executable under the curated `.local/bin` root stays owned; the home-top-level dotfile
      // is not, because the `$HOME` root was dropped for this window.
      expect(record?.owned.some((entry) => entry.path === join(home, ".local", "bin", "observetool"))).toBe(true);
      expect(record?.owned.some((entry) => entry.path === join(home, ".observetoolrc"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("a relative --observe path is refused before the installer runs", async () => {
    const home = makeHome();
    const server = serve(INSTALL_SCRIPT);
    try {
      const result = await runCliResult(["install", server.url, "--observe", "state"], home);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("--observe requires an absolute path: state");
      expect(existsSync(join(home, ".local", "bin", "mytool"))).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
