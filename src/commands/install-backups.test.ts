import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Criterion 3, end to end through the shipped commands, in a throwaway $HOME: `install --backup`
// captures before-image bytes for files it overwrites or deletes, and `uninstall --yes` restores
// them; with backups off the same install records the changes but preserves the current files and
// reports a conflict instead of inventing a restore. A file the user edits after install is never
// overwritten, even with backups on.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-backup-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** Runs the CLI from source as a child process so its `process.exit` never kills the test runner. */
async function runCli(args: string[], home: string): Promise<number> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, HOME: home },
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

/** Overwrites one pre-existing config, deletes another, and installs one executable. */
const INSTALL_SCRIPT = `#!/bin/bash
set -e
mkdir -p "$HOME/.config/mytool" "$HOME/.local/bin"
printf 'installed-config\\n' > "$HOME/.config/mytool/keep.conf"
rm -f "$HOME/.config/mytool/gone.conf"
printf '#!/bin/sh\\necho mytool\\n' > "$HOME/.local/bin/mytool"
chmod +x "$HOME/.local/bin/mytool"
`;

const keepPath = (home: string) => join(home, ".config", "mytool", "keep.conf");
const gonePath = (home: string) => join(home, ".config", "mytool", "gone.conf");

/** Lays down the pre-existing files the installer will overwrite and delete. */
function seedHome(home: string): void {
  mkdirSync(join(home, ".config", "mytool"), { recursive: true });
  writeFileSync(keepPath(home), "original-config\n");
  writeFileSync(gonePath(home), "original-gone\n");
}

type StoredEntry = { path: string; beforeBlob?: string; installedHash?: string };
type StoredRecord = { name: string; owned: StoredEntry[]; mutated: StoredEntry[]; deleted: StoredEntry[] };
type StoredFile = { version: number; records: StoredRecord[] };

function readStore(home: string): StoredFile {
  return JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8"));
}

function findRecord(file: StoredFile, name: string): StoredRecord {
  const record = file.records.find((entry) => entry.name === name);
  if (!record) throw new Error(`no record named ${name}`);
  return record;
}

describe("install --backup -> uninstall restores", () => {
  test("captures before-images and restores an overwritten and a deleted user file", async () => {
    const home = makeHome();
    seedHome(home);
    const server = serve(INSTALL_SCRIPT);
    try {
      expect(await runCli(["install", server.url, "--backup"], home)).toBe(0);

      const record = findRecord(readStore(home), "mytool");
      const kept = record.mutated.find((entry) => entry.path === keepPath(home));
      const gone = record.deleted.find((entry) => entry.path === gonePath(home));
      expect(kept?.beforeBlob).toBeDefined();
      expect(gone?.beforeBlob).toBeDefined();
      // The blob is genuinely on disk under its content address, not just named in the record.
      expect(existsSync(join(home, ".tret", "objects", kept!.beforeBlob!))).toBe(true);
      expect(existsSync(join(home, ".tret", "objects", gone!.beforeBlob!))).toBe(true);

      // Dry run plans a restore without touching disk.
      expect(await runCli(["uninstall", "mytool", "--dry-run"], home)).toBe(0);
      expect(readFileSync(keepPath(home), "utf8")).toBe("installed-config\n");

      expect(await runCli(["uninstall", "mytool", "--yes"], home)).toBe(0);
      expect(readFileSync(keepPath(home), "utf8")).toBe("original-config\n");
      expect(readFileSync(gonePath(home), "utf8")).toBe("original-gone\n");
      expect(existsSync(join(home, ".local", "bin", "mytool"))).toBe(false);
      expect(readStore(home).records).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  test("with backups off, records the changes but uninstall conflicts and preserves current files", async () => {
    const home = makeHome();
    seedHome(home);
    const server = serve(INSTALL_SCRIPT);
    try {
      expect(await runCli(["install", server.url], home)).toBe(0);

      const record = findRecord(readStore(home), "mytool");
      expect(record.mutated.find((entry) => entry.path === keepPath(home))?.beforeBlob).toBeUndefined();
      expect(record.deleted.find((entry) => entry.path === gonePath(home))?.beforeBlob).toBeUndefined();

      // The mutation is still detectable (installed hash recorded), it just cannot be restored.
      expect(record.mutated.find((entry) => entry.path === keepPath(home))?.installedHash).toBeDefined();

      expect(await runCli(["uninstall", "mytool", "--yes"], home)).not.toBe(0);
      expect(readFileSync(keepPath(home), "utf8")).toBe("installed-config\n");
      expect(existsSync(gonePath(home))).toBe(false);
      // The record survives for a safe retry.
      expect(findRecord(readStore(home), "mytool")).toBeDefined();
    } finally {
      await server.stop();
    }
  });

  test("a file edited after install is preserved as a conflict even with backups on", async () => {
    const home = makeHome();
    seedHome(home);
    const server = serve(INSTALL_SCRIPT);
    try {
      expect(await runCli(["install", server.url, "--backup"], home)).toBe(0);
      writeFileSync(keepPath(home), "user-edit\n");

      expect(await runCli(["uninstall", "mytool", "--yes"], home)).not.toBe(0);
      expect(readFileSync(keepPath(home), "utf8")).toBe("user-edit\n");
    } finally {
      await server.stop();
    }
  });
});
