import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

async function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<number> {
  return (await runCliResult(args, home, extraEnv)).code;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Whether a symlink itself is present, even when its target is missing (unlike `existsSync`). */
function linkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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

  test("uninstall keeps a changed file unless --force is used", async () => {
    const home = makeHome();
    const file = join(home, "tool");
    writeFileSync(file, "changed");
    writeRecords(home, [record({ owned: [{ path: file, kind: "file", installedHash: sha256("installed") }] })]);

    expect(await runCli(["uninstall", "mytool", "--yes"], home)).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe("changed");
    expect(readRecords(home).records).toHaveLength(1);

    expect(await runCli(["uninstall", "mytool", "--yes", "--force"], home)).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("uninstall keeps a changed symlink unless --force is used", async () => {
    const home = makeHome();
    const link = join(home, "tool-link");
    symlinkSync("changed-target", link);
    writeRecords(home, [record({ owned: [{ path: link, kind: "symlink", linkTarget: "installed-target" }] })]);

    expect(await runCli(["uninstall", "mytool", "--yes"], home)).not.toBe(0);
    expect(linkExists(link)).toBe(true);
    expect(readlinkSync(link)).toBe("changed-target");
    expect(readRecords(home).records).toHaveLength(1);

    expect(await runCli(["uninstall", "mytool", "--yes", "--force"], home)).toBe(0);
    expect(linkExists(link)).toBe(false);
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

    expect(linkExists(shim)).toBe(false);
    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(join(home, "fake-bun-args.txt"), "utf8").trim().split("\n")).toEqual(["remove", "-g", "@acme/tool"]);
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("blocks package-manager removal when another record claims a descendant, even with --force", async () => {
    const home = makeHome();
    const shim = join(home, ".bun", "bin", "acmetool");
    const packageDir = join(home, ".bun", "install", "global", "node_modules", "@acme", "tool");
    const claimedPath = join(packageDir, "nested", "owned.txt");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(join(packageDir, "nested"), { recursive: true });
    symlinkSync("../install/global/node_modules/@acme/tool/cli.js", shim);
    writeFileSync(claimedPath, "owned by another tool");

    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeBun = join(fakebin, "bun");
    writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' called > "$HOME/fake-bun-called"\nrm -rf "$HOME/.bun/install/global/node_modules/@acme/tool"\nexit 0\n`,
    );
    chmodSync(fakeBun, 0o755);

    writeRecords(home, [
      record({
        id: "rec-managed",
        name: "acmetool",
        executable: shim,
        owned: [{ path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" }],
        managedBy: { manager: "bun", package: "@acme/tool" },
      }),
      record({
        id: "rec-other",
        name: "other-tool",
        owned: [{ path: claimedPath, kind: "file", installedHash: sha256("owned by another tool") }],
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    const result = await runCliResult(["uninstall", "acmetool", "--yes", "--force"], home, { PATH: path });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("conflict:");
    expect(`${result.stdout}\n${result.stderr}`).toContain(claimedPath);
    expect(`${result.stdout}\n${result.stderr}`).toContain("other-tool");
    expect(existsSync(join(home, "fake-bun-called"))).toBe(false);
    expect(existsSync(packageDir)).toBe(true);
    expect(linkExists(shim)).toBe(true);
    expect(existsSync(claimedPath)).toBe(true);
    expect(readRecords(home).records.map((entry) => entry.id)).toEqual(["rec-managed", "rec-other"]);
  });

  test("dry-run reports a delegated-removal conflict and exits non-zero", async () => {
    const home = makeHome();
    const shim = join(home, ".bun", "bin", "acmetool");
    const packageDir = join(home, ".bun", "install", "global", "node_modules", "@acme", "tool");
    const claimedPath = join(packageDir, "nested", "owned.txt");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(join(packageDir, "nested"), { recursive: true });
    symlinkSync("../install/global/node_modules/@acme/tool/cli.js", shim);
    writeFileSync(claimedPath, "owned by another tool");

    writeRecords(home, [
      record({
        id: "rec-managed",
        name: "acmetool",
        executable: shim,
        owned: [{ path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" }],
        managedBy: { manager: "bun", package: "@acme/tool" },
      }),
      record({
        id: "rec-other",
        name: "other-tool",
        owned: [{ path: claimedPath, kind: "file", installedHash: sha256("owned by another tool") }],
      }),
    ]);

    const result = await runCliResult(["uninstall", "acmetool", "--dry-run"], home);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("conflict:");
    expect(`${result.stdout}\n${result.stderr}`).toContain(claimedPath);
    expect(existsSync(claimedPath)).toBe(true);
    expect(linkExists(shim)).toBe(true);
    expect(readRecords(home).records.map((entry) => entry.id)).toEqual(["rec-managed", "rec-other"]);
  });

  test("allows package-manager removal when another record claims a sibling package", async () => {
    const home = makeHome();
    const shim = join(home, ".bun", "bin", "acmetool");
    const globalRoot = join(home, ".bun", "install", "global");
    const packageDir = join(globalRoot, "node_modules", "@acme", "tool");
    const siblingClaim = join(globalRoot, "node_modules", "@acme", "other", "keep.txt");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(globalRoot, "node_modules", "@acme", "other"), { recursive: true });
    symlinkSync("../install/global/node_modules/@acme/tool/cli.js", shim);
    writeFileSync(join(packageDir, "cli.js"), "target package");
    writeFileSync(siblingClaim, "sibling package");

    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeBun = join(fakebin, "bun");
    writeFileSync(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' called > "$HOME/fake-bun-called"\nrm -rf "$HOME/.bun/install/global/node_modules/@acme/tool"\nexit 0\n`,
    );
    chmodSync(fakeBun, 0o755);

    writeRecords(home, [
      record({
        id: "rec-managed",
        name: "acmetool",
        executable: shim,
        owned: [{ path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" }],
        managedBy: { manager: "bun", package: "@acme/tool" },
      }),
      record({
        id: "rec-other",
        name: "other-tool",
        owned: [{ path: siblingClaim, kind: "file", installedHash: sha256("sibling package") }],
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    expect(await runCli(["uninstall", "acmetool", "--yes"], home, { PATH: path })).toBe(0);

    expect(existsSync(join(home, "fake-bun-called"))).toBe(true);
    expect(existsSync(packageDir)).toBe(false);
    expect(linkExists(shim)).toBe(false);
    expect(readFileSync(siblingClaim, "utf8")).toBe("sibling package");
    expect(readRecords(home).records.map((entry) => entry.id)).toEqual(["rec-other"]);
  });

  test("a managed npm global is removed through its recorded prefix", async () => {
    const home = makeHome();
    const prefix = join(home, ".local");
    const shim = join(prefix, "bin", "acmetool");
    const packageDir = join(prefix, "lib", "node_modules", "@acme", "tool");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    symlinkSync("../lib/node_modules/@acme/tool/cli.js", shim);

    // A fake `npm` records its arguments and does what `npm uninstall -g --prefix` would do.
    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeNpm = join(fakebin, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/fake-npm-args.txt"\nrm -rf "$HOME/.local/lib/node_modules/@acme/tool"\nexit 0\n`,
    );
    chmodSync(fakeNpm, 0o755);

    writeRecords(home, [
      record({
        name: "acmetool",
        executable: shim,
        owned: [{ path: shim, kind: "symlink", linkTarget: "../lib/node_modules/@acme/tool/cli.js" }],
        managedBy: { manager: "npm", package: "@acme/tool", globalRoot: join(prefix, "lib") },
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    expect(await runCli(["uninstall", "acmetool", "--yes"], home, { PATH: path })).toBe(0);

    expect(linkExists(shim)).toBe(false);
    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(join(home, "fake-npm-args.txt"), "utf8").trim().split("\n")).toEqual([
      "uninstall",
      "-g",
      "--prefix",
      prefix,
      "@acme/tool",
    ]);
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("recognizes an npm global on a record written before managedBy existed", async () => {
    const home = makeHome();
    const shim = join(home, ".npm-global", "bin", "eslint");
    const libDir = join(home, ".npm-global", "lib");
    const packageDir = join(libDir, "node_modules", "eslint");
    mkdirSync(join(home, ".npm-global", "bin"), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    symlinkSync("../lib/node_modules/eslint/bin/eslint.js", shim);

    const fakebin = join(home, "fakebin");
    mkdirSync(fakebin, { recursive: true });
    const fakeNpm = join(fakebin, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/fake-npm-args.txt"\nrm -rf "$HOME/.npm-global/lib/node_modules/eslint"\nexit 0\n`,
    );
    chmodSync(fakeNpm, 0o755);

    // A record from before `managedBy`: it owns the shared `lib` directory too. That shared tree is
    // dropped from the plan, while the shim still comes off and npm removes the package by prefix.
    writeRecords(home, [
      record({
        name: "eslint",
        executable: shim,
        owned: [
          { path: shim, kind: "symlink", linkTarget: "../lib/node_modules/eslint/bin/eslint.js" },
          { path: libDir, kind: "directory" },
        ],
      }),
    ]);

    const path = `${fakebin}:${process.env.PATH ?? ""}`;
    expect(await runCli(["uninstall", "eslint", "--yes"], home, { PATH: path })).toBe(0);

    expect(existsSync(libDir)).toBe(true);
    expect(linkExists(shim)).toBe(false);
    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(join(home, "fake-npm-args.txt"), "utf8").trim().split("\n")).toEqual([
      "uninstall",
      "-g",
      "--prefix",
      join(home, ".npm-global"),
      "eslint",
    ]);
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

    // The manager runs first and failed, so Tret touched nothing: the shim and package both remain
    // and the record is kept for a retry.
    expect(linkExists(shim)).toBe(true);
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
    expect(linkExists(shim)).toBe(false);
    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(join(home, "fake-bun-args.txt"), "utf8").trim().split("\n")).toEqual(["remove", "-g", "@acme/tool"]);
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("removes a managed install recognized from its executable when the record predates the field", async () => {
    const home = makeHome();
    const root = join(home, ".pi", "agent", "install");
    const launcher = join(home, ".pi", "agent", "bin", "pi");
    mkdirSync(join(root, "releases", "1.0.0", "node_modules"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "bin"), { recursive: true });
    writeFileSync(
      join(root, "managed-install.json"),
      JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
    );
    // Untracked payload capture skipped; a record written before `managedInstall` exists owns only
    // the wrapper directories, so removing them alone would leave every ancestor `not-empty`.
    writeFileSync(join(root, "releases", "1.0.0", "node_modules", "blob.js"), "x");
    writeFileSync(launcher, "#!/bin/sh\n");

    writeRecords(home, [
      record({
        name: "pi",
        executable: launcher,
        owned: [
          { path: join(home, ".pi"), kind: "directory" },
          { path: join(home, ".pi", "agent"), kind: "directory" },
          { path: join(home, ".pi", "agent", "bin"), kind: "directory" },
          { path: join(home, ".pi", "agent", "bin", "pi"), kind: "file", installedHash: sha256("#!/bin/sh\n") },
        ],
      }),
    ]);

    expect(await runCli(["uninstall", "pi", "--yes"], home)).toBe(0);

    // The delegated recursive removal clears the root and its payload; Tret clears the ancestors.
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(readRecords(home).records).toHaveLength(0);
  });

  test("does not recursively remove a managed-install root with another record's descendant claim, even with --force", async () => {
    const home = makeHome();
    const root = join(home, ".pi", "agent", "install");
    const launcher = join(home, ".pi", "agent", "bin", "pi");
    const claimedPath = join(root, "releases", "1.0.0", "owned.txt");
    mkdirSync(join(root, "releases", "1.0.0"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "bin"), { recursive: true });
    writeFileSync(
      join(root, "managed-install.json"),
      JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
    );
    writeFileSync(launcher, "#!/bin/sh\n");
    writeFileSync(claimedPath, "owned by another tool");

    writeRecords(home, [
      record({
        id: "rec-managed",
        name: "pi",
        executable: launcher,
        owned: [{ path: launcher, kind: "file", installedHash: sha256("#!/bin/sh\n") }],
        managedInstall: { kind: "pi-managed-install", layout: "releases-v1", root },
      }),
      record({
        id: "rec-other",
        name: "other-tool",
        owned: [{ path: claimedPath, kind: "file", installedHash: sha256("owned by another tool") }],
      }),
    ]);

    const result = await runCliResult(["uninstall", "pi", "--yes", "--force"], home);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("conflict:");
    expect(`${result.stdout}\n${result.stderr}`).toContain(claimedPath);
    expect(`${result.stdout}\n${result.stderr}`).toContain("other-tool");
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(claimedPath, "utf8")).toBe("owned by another tool");
    expect(existsSync(launcher)).toBe(true);
    expect(readRecords(home).records.map((entry) => entry.id)).toEqual(["rec-managed", "rec-other"]);
  });

  test("a records file with a malformed nested entry is rejected without overwriting it", async () => {
    const home = makeHome();
    const malformed = JSON.stringify({
      version: 3,
      records: [{ ...record(), owned: [{ path: "relative/tool", kind: "file" }] }],
    });
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(join(home, ".tret", "records.json"), malformed);

    const result = await runCliResult(["uninstall", "mytool", "--yes"], home);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("could not read the install records");
    expect(readFileSync(join(home, ".tret", "records.json"), "utf8")).toBe(malformed);
  });
});

describe("uninstall ownership confidence", () => {
  test("a heuristic record's destructive plan is labeled as observed, not proven", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");

    writeRecords(home, [
      record({ executable: binary, owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }] }),
    ]);

    const result = await runCliResult(["uninstall", "mytool", "--dry-run"], home);

    expect(result.code).toBe(0);
    // `log` writes to the terminal, not a piped stdout, so read the combined output.
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("note: these paths are observed, not proven to belong to this tool");
    expect(output).toContain(`would remove ${binary} (observed, not proven)`);
  });

  test("a complete record's destructive plan carries no observed caveat", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");

    writeRecords(home, [
      record({
        executable: binary,
        capture: {
          backend: "linux-fanotify",
          completeness: "complete",
          segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
        },
        owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }],
      }),
    ]);

    const result = await runCliResult(["uninstall", "mytool", "--dry-run"], home);

    expect(result.code).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain(`would remove ${binary}`);
    expect(output).not.toContain("only observed");
    expect(output).not.toContain("(observed, not proven)");
  });
});
