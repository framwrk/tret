import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

// End-to-end cover for post-command blob collection (plan step 9): a record that stops referencing a
// before-image leaves an orphan under `~/.tret/objects/`, and a successful uninstall/forget/unclaim
// or forced replacement sweeps aged orphans without touching blobs another record still needs. The
// 60-second grace keeps a fresh blob (possibly an install still in flight) and cleanup failures never
// change a command that already succeeded.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-blob-gc-"));
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

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function objectsDir(home: string): string {
  return join(home, ".tret", "objects");
}

function blobPath(home: string, id: string): string {
  return join(objectsDir(home), id);
}

/** Writes a content-addressed blob as an install with backups on would have. */
function writeBlob(home: string, text: string): string {
  const id = sha256(text);
  mkdirSync(objectsDir(home), { recursive: true });
  writeFileSync(blobPath(home, id), text);
  return id;
}

/** Ages a blob past the 60-second command grace window. */
function ageBlob(home: string, id: string): void {
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(blobPath(home, id), past, past);
}

function writeRecords(home: string, records: RecordV3[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
}

function readRecords(home: string): RecordV3[] {
  return (JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as { records: RecordV3[] }).records;
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

/** Serves one raw script over loopback; the install URL needs a dotted host and a non-HTML body. */
function serve(script: string): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(script, { headers: { "content-type": "text/plain" } }),
  });
  return { url: `http://127.0.0.1:${server.port}/install.sh`, stop: () => server.stop(true) };
}

describe("post-command blob collection", () => {
  test("uninstall reclaims an aged before-image but keeps a blob another record references", async () => {
    const home = makeHome();
    const goneBlob = writeBlob(home, "before-gone\n");
    const keptBlob = writeBlob(home, "before-kept\n");
    const gonePath = join(home, ".config", "gone.conf");
    const keptPath = join(home, ".config", "kept.conf");
    writeRecords(home, [
      record({ id: "rec-gone", name: "gone", deleted: [{ path: gonePath, beforeBlob: goneBlob }] }),
      record({ id: "rec-kept", name: "kept", mutated: [{ path: keptPath, beforeBlob: keptBlob }] }),
    ]);
    ageBlob(home, goneBlob);
    ageBlob(home, keptBlob);

    const result = await runCliResult(["uninstall", "gone", "--yes", "--json"], home);

    expect(result.code).toBe(0);
    // The removed record's blob was still available while the restore ran, then collected.
    expect(readFileSync(gonePath, "utf8")).toBe("before-gone\n");
    expect(existsSync(blobPath(home, goneBlob))).toBe(false);
    expect(existsSync(blobPath(home, keptBlob))).toBe(true);
    expect(readRecords(home).map((entry) => entry.id)).toEqual(["rec-kept"]);
  });

  test("forget reclaims an aged orphan without touching the tool's files", async () => {
    const home = makeHome();
    const blob = writeBlob(home, "before-config\n");
    const binary = join(home, ".local", "bin", "mytool");
    const config = join(home, ".config", "mytool.conf");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");
    writeRecords(home, [
      record({
        owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }],
        mutated: [{ path: config, beforeBlob: blob }],
      }),
    ]);
    ageBlob(home, blob);

    const result = await runCliResult(["forget", "mytool", "--json"], home);

    expect(result.code).toBe(0);
    expect(readRecords(home)).toEqual([]);
    expect(readFileSync(binary, "utf8")).toBe("installed");
    expect(existsSync(blobPath(home, blob))).toBe(false);
  });

  test("a fresh orphan survives the grace window and is collected by a later mutation", async () => {
    const home = makeHome();
    const freshBlob = writeBlob(home, "just-orphaned\n");
    const nextBlob = writeBlob(home, "next-config\n");
    writeRecords(home, [record({ id: "rec-fresh", name: "fresh", mutated: [{ path: "/h/fresh", beforeBlob: freshBlob }] })]);

    expect((await runCliResult(["forget", "fresh", "--json"], home)).code).toBe(0);
    // Too new to sweep: a concurrent install could have written this blob but not saved its record.
    expect(existsSync(blobPath(home, freshBlob))).toBe(true);

    ageBlob(home, freshBlob);
    writeRecords(home, [record({ id: "rec-next", name: "next", mutated: [{ path: "/h/next", beforeBlob: nextBlob }] })]);
    expect((await runCliResult(["forget", "next", "--json"], home)).code).toBe(0);

    // The aged orphan goes; the second record's own still-fresh blob is spared.
    expect(existsSync(blobPath(home, freshBlob))).toBe(false);
    expect(existsSync(blobPath(home, nextBlob))).toBe(true);
  });

  test("unclaim reclaims an aged orphan and preserves the remaining record's blob", async () => {
    const home = makeHome();
    const orphan = writeBlob(home, "orphan\n");
    const referenced = writeBlob(home, "still-referenced\n");
    const path = join(home, "bin", "tool");
    const entry = { path, kind: "file" as const, installedHash: sha256("shared") };
    writeRecords(home, [
      record({ id: "rec-a", name: "a", owned: [entry] }),
      record({
        id: "rec-b",
        name: "b",
        owned: [entry],
        mutated: [{ path: join(home, ".config", "b.conf"), beforeBlob: referenced }],
      }),
    ]);
    ageBlob(home, orphan);
    ageBlob(home, referenced);

    const result = await runCliResult(["unclaim", "a", path, "--json"], home);

    expect(result.code).toBe(0);
    expect(existsSync(blobPath(home, orphan))).toBe(false);
    expect(existsSync(blobPath(home, referenced))).toBe(true);
    expect(readRecords(home)).toHaveLength(2);
  });

  test("a forced replacement reclaims the old record's aged before-image", async () => {
    const home = makeHome();
    const executable = join(home, ".local", "bin", "mytool");
    const oldConfig = join(home, ".config", "oldtool.conf");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, ".config"), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\necho mytool\n");
    chmodSync(executable, 0o755);
    writeFileSync(oldConfig, "old-installed\n");
    const oldBlob = writeBlob(home, "old-original\n");
    const server = serve(`#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config"
printf '#!/bin/sh\\necho mytool-v2\\n' > "$HOME/.local/bin/mytool"
chmod +x "$HOME/.local/bin/mytool"
printf 'second\\n' > "$HOME/.config/newtool.conf"
`);
    try {
      writeRecords(home, [
        record({
          id: "rec-old",
          url: server.url,
          executable,
          owned: [{ path: executable, kind: "file", installedHash: sha256("#!/bin/sh\necho mytool\n") }],
          mutated: [{ path: oldConfig, installedHash: sha256("old-installed\n"), beforeBlob: oldBlob, mode: 0o644 }],
        }),
      ]);
      ageBlob(home, oldBlob);

      const result = await runCliResult(["install", server.url, "--force", "--backup"], home);

      expect(result.code).toBe(0);
      // The old install was restored before removal, and its now-unreferenced blob was collected.
      expect(readFileSync(oldConfig, "utf8")).toBe("old-original\n");
      expect(existsSync(blobPath(home, oldBlob))).toBe(false);
      const saved = readRecords(home);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.id).not.toBe("rec-old");
      expect(saved[0]!.name).toBe("mytool");
    } finally {
      await server.stop();
    }
  });

  test("a failed collection does not change the command's successful result", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");
    writeRecords(home, [
      record({ owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }] }),
    ]);
    // An objects path that is not a directory makes the sweep throw; the command must still succeed.
    writeFileSync(objectsDir(home), "not a directory");

    const result = await runCliResult(["uninstall", "mytool", "--yes", "--json"], home);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "uninstall" });
    expect(existsSync(binary)).toBe(false);
    expect(readRecords(home)).toEqual([]);
  });
});
