import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end cover for the uninstall record lifecycle, in a throwaway $HOME: a record whose muta-
// tions/deletions have no before-image is detect-only and must not block completion (the churn bug),
// while a restorable change whose blob is gone still conflicts and keeps the record (D2/D4). `forget`
// is the escape hatch that drops a record without touching files.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-uninstall-cli-"));
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

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Writes a valid v3 records file by hand, so a test controls the exact record shape. */
function writeRecords(home: string, records: RecordV3[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
}

function readRecords(home: string): { version: number; records: RecordV3[] } {
  return JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8"));
}

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "macos-heuristic",
      completeness: "heuristic",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

describe("uninstall record lifecycle", () => {
  test("detect-only churn is reported but does not block; owned paths go and the record drops", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool");
    const churn = join(home, ".raycast", "db-wal");
    const gone = join(home, ".config", "gone.conf");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, ".raycast"), { recursive: true });
    writeFileSync(binary, "installed");
    writeFileSync(churn, "churn");

    writeRecords(home, [
      record({
        executable: binary,
        owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }],
        // Unrelated system churn: recorded as a mutation, but with no before-image to restore.
        mutated: [{ path: churn, installedHash: sha256("churn") }],
        deleted: [{ path: gone }],
      }),
    ]);

    expect(await runCli(["uninstall", "mytool", "--yes"], home)).toBe(0);

    // The owned binary is removed; the detect-only change and deletion are left untouched.
    expect(existsSync(binary)).toBe(false);
    expect(readFileSync(churn, "utf8")).toBe("churn");
    expect(existsSync(gone)).toBe(false);
    // Nothing actionable remained, so the record is gone rather than reduced forever.
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("a restorable mutation whose blob is missing still conflicts and retains the record", async () => {
    const home = makeHome();
    const config = join(home, ".config", "mytool", "keep.conf");
    mkdirSync(join(home, ".config", "mytool"), { recursive: true });
    writeFileSync(config, "installed");

    writeRecords(home, [
      record({
        mutated: [
          // A before-image address that storage does not hold: restorable in principle, blocked in fact.
          { path: config, installedHash: sha256("installed"), beforeBlob: "a".repeat(64) },
        ],
      }),
    ]);

    expect(await runCli(["uninstall", "mytool", "--yes"], home)).not.toBe(0);
    expect(readFileSync(config, "utf8")).toBe("installed");
    // The actionable conflict keeps the record for a safe retry.
    const file = readRecords(home);
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.mutated).toHaveLength(1);
  });

  test("forget drops a record whose only entries are detect-only, without touching files", async () => {
    const home = makeHome();
    const churn = join(home, ".config", "churn.conf");
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(churn, "churn");

    writeRecords(home, [record({ mutated: [{ path: churn, installedHash: sha256("churn") }] })]);

    expect(await runCli(["forget", "mytool"], home)).toBe(0);
    expect(readFileSync(churn, "utf8")).toBe("churn");
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("forget on an unknown tool fails without writing", async () => {
    const home = makeHome();
    writeRecords(home, [record()]);
    expect(await runCli(["forget", "nope"], home)).toBe(1);
    expect(readRecords(home).records).toHaveLength(1);
  });

  test("a managed global package is removed through its package manager", async () => {
    const home = makeHome();
    const shim = join(home, ".bun", "bin", "acmetool");
    const packageDir = join(home, ".bun", "install", "global", "node_modules", "@acme", "tool");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    symlinkSync("../install/global/node_modules/@acme/tool/cli.js", shim);

    // A fake `bun` on PATH records its arguments and does what `bun remove -g` would do.
    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeBun = join(fakebin, "bun");
    writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/fake-bun-args.txt"\nrm -rf "$HOME/.bun/install/global/node_modules/@acme/tool"\nexit 0\n`,
    );
    chmodSync(fakeBun, 0o755);

    writeRecords(home, [
      record({
        name: "acmetool",
        executable: shim,
        owned: [{ path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" }],
        managedBy: { manager: "bun", package: "@acme/tool" },
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    expect(await runCli(["uninstall", "acmetool", "--yes"], home, { PATH: path })).toBe(0);

    expect(existsSync(shim)).toBe(false);
    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(join(home, "fake-bun-args.txt"), "utf8").trim().split("\n")).toEqual(["remove", "-g", "@acme/tool"]);
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("a managed package the manager cannot remove keeps the record for a retry", async () => {
    const home = makeHome();
    const shim = join(home, ".bun", "bin", "acmetool");
    const packageDir = join(home, ".bun", "install", "global", "node_modules", "@acme", "tool");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    symlinkSync("../install/global/node_modules/@acme/tool/cli.js", shim);

    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeBun = join(fakebin, "bun");
    writeFileSync(fakeBun, `#!/bin/sh\necho 'remove failed' >&2\nexit 1\n`);
    chmodSync(fakeBun, 0o755);

    writeRecords(home, [
      record({
        name: "acmetool",
        executable: shim,
        owned: [{ path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" }],
        managedBy: { manager: "bun", package: "@acme/tool" },
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    expect(await runCli(["uninstall", "acmetool", "--yes"], home, { PATH: path })).not.toBe(0);

    // The shim was removed, but the package survives, so the record stays with its managed package.
    expect(existsSync(packageDir)).toBe(true);
    const file = readRecords(home);
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.managedBy).toEqual({ manager: "bun", package: "@acme/tool" });
  });

  test("recognizes a managed package on a record written before managedBy existed", async () => {
    const home = makeHome();
    const shim = join(home, ".bun", "bin", "acmetool");
    const globalDir = join(home, ".bun", "install", "global");
    const manifest = join(globalDir, "package.json");
    const packageDir = join(globalDir, "node_modules", "@acme", "tool");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(manifest, "{}");
    symlinkSync("../install/global/node_modules/@acme/tool/cli.js", shim);

    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeBun = join(fakebin, "bun");
    writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/fake-bun-args.txt"\nrm -rf "$HOME/.bun/install/global/node_modules/@acme/tool"\nexit 0\n`,
    );
    chmodSync(fakeBun, 0o755);

    // A record from before `managedBy`: it owns the shared global directory and manifest too.
    writeRecords(home, [
      record({
        name: "acmetool",
        executable: shim,
        owned: [
          { path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" },
          { path: globalDir, kind: "directory" },
          { path: manifest, kind: "file" },
        ],
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    expect(await runCli(["uninstall", "acmetool", "--yes"], home, { PATH: path })).toBe(0);

    // Shared state survives; only the shim is removed by Tret and the package by the manager.
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(globalDir)).toBe(true);
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(join(home, "fake-bun-args.txt"), "utf8").trim().split("\n")).toEqual(["remove", "-g", "@acme/tool"]);
    expect(readRecords(home).records).toHaveLength(0);
  });
});
