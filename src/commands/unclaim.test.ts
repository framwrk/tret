import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Cover for `tret unclaim` (D4). The command resolves a shared-owner conflict explicitly: it
// changes no files, drops only the selected record's claim, and never lets an unshared claim be
// dropped (that is `forget`). The end-to-end test proves the same shared path is then removable by
// its remaining owner without `--force`, and that the file survives the unclaim itself.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-unclaim-cli-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function runCliResult(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, HOME: home },
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

function writeRecords(home: string, records: RecordV3[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
}

function readRecords(home: string): RecordV3[] {
  return (JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as { records: RecordV3[] }).records;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "/home/.local/bin/mytool",
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

function sharedPair(path: string): RecordV3[] {
  const entry = { path, kind: "file" as const, installedHash: sha256("shared") };
  return [record({ owned: [entry] }), record({ id: "rec-2", name: "othertool", owned: [entry] })];
}

describe("unclaim CLI", () => {
  test("requires both a tool selector and a path", async () => {
    const home = makeHome();
    expect((await runCliResult(["unclaim"], home)).code).toBe(EXIT_USAGE);
    expect((await runCliResult(["unclaim", "mytool"], home)).code).toBe(EXIT_USAGE);
    expect((await runCliResult(["unclaim", "mytool", "--json"], home)).code).toBe(EXIT_USAGE);
    expect((await runCliResult(["unclaim", "--json", "/h/bin/tool"], home)).code).toBe(EXIT_USAGE);
  });

  test("an unknown tool exits with the not-found code", async () => {
    const home = makeHome();
    const result = await runCliResult(["unclaim", "nope", "/h/bin/tool", "--json"], home);

    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "unclaim-not-found", message: "no tracked install matches nope" },
    });
  });

  test("a shared name is ambiguous and lists the candidate ids", async () => {
    const home = makeHome();
    writeRecords(home, [record({ id: "rec-a", name: "dup" }), record({ id: "rec-b", name: "dup" })]);
    const result = await runCliResult(["unclaim", "dup", "/h/bin/tool", "--json"], home);

    expect(result.code).toBe(EXIT_AMBIGUOUS);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: "unclaim-ambiguous",
        message: "2 tracked installs are named dup; select one by record id",
      },
    });
  });

  test("refuses a path the selected record does not claim", async () => {
    const home = makeHome();
    writeRecords(home, [
      record({ id: "rec-a", name: "a" }),
      record({ id: "rec-b", name: "b", owned: [{ path: "/h/bin/tool", kind: "file", installedHash: sha256("x") }] }),
    ]);
    const before = readRecords(home);

    const result = await runCliResult(["unclaim", "a", "/h/bin/tool", "--json"], home);

    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "unclaim-not-claimed", message: "a does not claim /h/bin/tool; nothing was changed" },
    });
    expect(readRecords(home)).toEqual(before);
  });

  test("refuses to drop the only claim; forget is the tool for that", async () => {
    const home = makeHome();
    writeRecords(home, [
      record({ id: "rec-a", name: "a", owned: [{ path: "/h/bin/tool", kind: "file", installedHash: sha256("x") }] }),
      record({ id: "rec-b", name: "b" }),
    ]);
    const before = readRecords(home);

    const result = await runCliResult(["unclaim", "a", "/h/bin/tool", "--json"], home);

    expect(result.code).toBe(EXIT_BLOCKED);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: "unclaim-not-shared",
        message: "a is the only record claiming /h/bin/tool; nothing was changed (use tret forget to stop tracking the tool)",
      },
    });
    expect(readRecords(home)).toEqual(before);
  });

  test("JSON mode drops the selected claim and names the remaining owner", async () => {
    const home = makeHome();
    const path = join(home, "bin", "tool");
    writeRecords(home, sharedPair(path));

    const result = await runCliResult(["unclaim", "mytool", path, "--json"], home);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      command: "unclaim",
      tool: "mytool",
      id: "rec-1",
      path,
      removed: ["owned"],
      remaining: [{ id: "rec-2", name: "othertool" }],
    });

    const saved = readRecords(home);
    expect(saved.find((entry) => entry.id === "rec-1")?.owned).toEqual([]);
    expect(saved.find((entry) => entry.id === "rec-2")?.owned).toEqual([
      { path, kind: "file", installedHash: sha256("shared") },
    ]);
  });

  test("human mode reports what was dropped and who still owns the path", async () => {
    const home = makeHome();
    const path = join(home, "bin", "tool");
    writeRecords(home, sharedPair(path));

    const result = await runCliResult(["unclaim", "mytool", path], home);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).toBe(0);
    expect(output).toContain(`unclaimed ${path} from mytool`);
    expect(output).toContain("removed the owned claim");
    expect(output).toContain("still claimed by othertool (rec-2)");
    expect(output).toContain("nothing on disk was changed");
  });

  test("a find record unclaims cleanly and keeps its observed label", async () => {
    const home = makeHome();
    const path = join(home, "bin", "tool");
    const found = record({
      id: "rec-find",
      name: "found",
      source: "find",
      executable: path,
      capture: {
        backend: "find",
        completeness: "heuristic",
        segments: [{ kind: "find", startedAt: "2026-10-09T00:00:00.000Z" }],
      },
      owned: [{ path, kind: "file", installedHash: sha256("shared") }],
    });
    writeRecords(home, [found, record({ id: "rec-2", name: "othertool", owned: [{ path, kind: "file" }] })]);

    expect((await runCliResult(["unclaim", "found", path, "--json"], home)).code).toBe(0);

    const saved = readRecords(home).find((entry) => entry.id === "rec-find");
    expect(saved?.capture).toEqual(found.capture);
    expect(saved?.owned).toEqual([]);
  });

  test("the remaining owner can plan a normal removal with no --force after the conflict is resolved", async () => {
    const home = makeHome();
    const path = join(home, "bin", "tool");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(path, "shared");
    writeRecords(home, sharedPair(path));

    const blockedFirst = await runCliResult(["uninstall", "mytool", "--dry-run", "--json"], home);
    expect(JSON.parse(blockedFirst.stdout).actions).toEqual([{ action: "conflict", path, reason: "shared-owner" }]);

    const unclaimed = await runCliResult(["unclaim", "mytool", path, "--json"], home);
    expect(unclaimed.code).toBe(0);

    // The record that gave up the claim no longer plans to touch the path.
    const resigned = await runCliResult(["uninstall", "mytool", "--dry-run", "--json"], home);
    expect(JSON.parse(resigned.stdout).actions).toEqual([]);

    // The remaining owner plans an ordinary removal; no forced fingerprint bypass is involved.
    const owner = await runCliResult(["uninstall", "othertool", "--dry-run", "--json"], home);
    const actions = JSON.parse(owner.stdout).actions as Array<{ action: string; path: string }>;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: "remove", path });

    // Resolving ownership never touched the file.
    expect(existsSync(path)).toBe(true);

    // The owner's plan applies as-is, with no --force, and removes only what it still owns.
    const removed = await runCliResult(["uninstall", "othertool", "--yes", "--json"], home);
    expect(removed.code).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});
