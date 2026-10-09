import { BlobCorruptionError, BlobTooLargeError, FileStorage, InvalidRecordError, RecordsCorruptionError } from "./store";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Every test gets its own home so records and blobs never collide; the directory is removed after.
const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-store-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function v3Record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "/home/.local/bin/mytool",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "linux-fanotify",
      completeness: "complete",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path: "/home/.local/bin/mytool", kind: "file", installedHash: "b".repeat(64) }],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

function v2Record(name: string): Record<string, unknown> {
  return {
    name,
    source: "install",
    url: `https://example.com/${name}.sh`,
    installedAt: "2026-10-03T00:00:00.000Z",
    executable: `/home/.local/bin/${name}`,
    scriptSha256: "a".repeat(64),
    added: [`/home/.local/bin/${name}`],
    edited: [`/home/.${name}rc`],
  };
}

const recordsPath = (home: string) => join(home, ".tret", "records.json");
const objectsDir = (home: string) => join(home, ".tret", "objects");
const blobPath = (home: string, id: string) => join(objectsDir(home), id);

describe("FileStorage records", () => {
  test("round-trips v3 records and replaces a record with the same id", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    await storage.saveRecord(v3Record());
    await storage.saveRecord(v3Record({ name: "renamed" }));

    const loaded = await storage.loadRecords();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe("renamed");
  });

  test("keeps other records and removes by id, ignoring an unknown id", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    await storage.saveRecord(v3Record({ id: "a" }));
    await storage.saveRecord(v3Record({ id: "b", name: "other" }));
    await storage.removeRecord("a");
    await storage.removeRecord("missing");

    expect((await storage.loadRecords()).map((record) => record.id)).toEqual(["b"]);
  });

  test("writes the records file as version 3 through a rename with no temp left behind", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    await storage.saveRecord(v3Record());

    const raw = JSON.parse(readFileSync(recordsPath(home), "utf8"));
    expect(raw.version).toBe(3);
    expect(raw.records).toHaveLength(1);
    expect(readdirSync(join(home, ".tret"))).toEqual(["records.json"]);
  });

  test("sets owner-only permissions on the records file and its directory", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    await storage.saveRecord(v3Record());

    expect(statSync(recordsPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".tret")).mode & 0o777).toBe(0o700);
  });

  test("rejects an invalid record without writing anything", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    await expect(storage.saveRecord({ id: "x" } as unknown as RecordV3)).rejects.toBeInstanceOf(InvalidRecordError);
    expect(existsSync(recordsPath(home))).toBe(false);
  });

  test("migrates a v2 file to v3 on disk without inventing restore capability", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(recordsPath(home), JSON.stringify({ version: 2, records: [v2Record("ripgrep")] }));

    const storage = new FileStorage({ homeDir: home });
    const records = await storage.loadRecords();

    expect(records).toHaveLength(1);
    expect(records[0]?.owned).toEqual([{ path: "/home/.local/bin/ripgrep", kind: "unknown" }]);
    expect(records[0]?.mutated).toEqual([{ path: "/home/.ripgreprc" }]);
    expect(records[0]?.deleted).toEqual([]);

    const onDisk = JSON.parse(readFileSync(recordsPath(home), "utf8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.records[0].capture.backend).toBe("legacy-v2");
  });

  test("rejects a corrupt records file and leaves its bytes untouched", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(recordsPath(home), "{ not json");

    const storage = new FileStorage({ homeDir: home });
    await expect(storage.loadRecords()).rejects.toBeInstanceOf(RecordsCorruptionError);
    expect(readFileSync(recordsPath(home), "utf8")).toBe("{ not json");
  });

  test("rejects a malformed v2 file and leaves its bytes untouched", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".tret"), { recursive: true });
    const malformed = JSON.stringify({ version: 2, records: [{ name: "x" }] });
    writeFileSync(recordsPath(home), malformed);

    const storage = new FileStorage({ homeDir: home });
    await expect(storage.loadRecords()).rejects.toBeInstanceOf(RecordsCorruptionError);
    expect(readFileSync(recordsPath(home), "utf8")).toBe(malformed);
  });

  test("does not overwrite a corrupt file when a save is attempted", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(recordsPath(home), "garbage");

    const storage = new FileStorage({ homeDir: home });
    await expect(storage.saveRecord(v3Record())).rejects.toBeInstanceOf(RecordsCorruptionError);
    expect(readFileSync(recordsPath(home), "utf8")).toBe("garbage");
  });

  test("quarantines a corrupt file on request, preserving its bytes", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(recordsPath(home), "garbage");

    const storage = new FileStorage({ homeDir: home, now: () => 0 });
    const target = await storage.quarantineCorruptRecords();

    expect(target).toBe(`${recordsPath(home)}.corrupt-1970-01-01T00-00-00-000Z`);
    expect(readFileSync(target!, "utf8")).toBe("garbage");
    expect(existsSync(recordsPath(home))).toBe(false);
    expect(await storage.loadRecords()).toEqual([]);
  });

  test("does not quarantine a healthy records file", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    await storage.saveRecord(v3Record());

    expect(await storage.quarantineCorruptRecords()).toBeUndefined();
    expect(existsSync(recordsPath(home))).toBe(true);
  });

  test("ignores a leftover temp file from an interrupted write", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    await storage.saveRecord(v3Record());

    const stale = `${recordsPath(home)}.${process.pid}.999.tmp`;
    writeFileSync(stale, "partial");

    expect((await storage.loadRecords()).map((record) => record.id)).toEqual(["rec-1"]);
    await storage.saveRecord(v3Record({ id: "rec-2" }));
    expect((await storage.loadRecords()).map((record) => record.id).sort()).toEqual(["rec-1", "rec-2"]);
  });
});

describe("FileStorage blobs", () => {
  test("stores blobs content-addressed and deduplicates by content", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    const first = await storage.putBlob(bytes("before-image"));
    const second = await storage.putBlob(bytes("before-image"));

    expect(second).toEqual(first);
    expect(first.id).toBe(sha256(bytes("before-image")));
    expect(readdirSync(objectsDir(home))).toEqual([first.id]);
    expect(new TextDecoder().decode(await storage.getBlob(first.id))).toBe("before-image");
  });

  test("gives different content different addresses", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    const first = await storage.putBlob(bytes("one"));
    const second = await storage.putBlob(bytes("two"));

    expect(first.id).not.toBe(second.id);
    expect(readdirSync(objectsDir(home)).sort()).toEqual([first.id, second.id].sort());
  });

  test("sets owner-only permissions on blobs and the objects directory", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    const blob = await storage.putBlob(bytes("secret-config"));

    expect(statSync(blobPath(home, blob.id)).mode & 0o777).toBe(0o600);
    expect(statSync(objectsDir(home)).mode & 0o777).toBe(0o700);
  });

  test("returns undefined for a missing or malformed address", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    expect(await storage.getBlob("f".repeat(64))).toBeUndefined();
    expect(await storage.getBlob("../escape")).toBeUndefined();
    expect(await storage.getBlob("not-a-hash")).toBeUndefined();
  });

  test("rejects a blob whose bytes no longer match its address, then repairs it", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    const content = bytes("original");
    const blob = await storage.putBlob(content);

    writeFileSync(blobPath(home, blob.id), "tampered");
    await expect(storage.getBlob(blob.id)).rejects.toBeInstanceOf(BlobCorruptionError);

    await storage.putBlob(content);
    expect(new TextDecoder().decode(await storage.getBlob(blob.id))).toBe("original");
  });

  test("honors the backup policy: off by default", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    expect(storage.backupsEnabled).toBe(false);
    expect(await storage.captureBeforeImage(bytes("config"))).toBeUndefined();
    expect(existsSync(objectsDir(home))).toBe(false);
  });

  test("stores a before-image when backups are enabled and within the limit", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home, backups: { enabled: true, sizeLimitBytes: 64 } });

    const blob = await storage.captureBeforeImage(bytes("config"));
    expect(blob).toBeDefined();
    expect(new TextDecoder().decode(await storage.getBlob(blob!.id))).toBe("config");
  });

  test("refuses content above the size limit and writes nothing", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home, backups: { enabled: true, sizeLimitBytes: 4 } });

    expect(await storage.captureBeforeImage(bytes("12345"))).toBeUndefined();
    await expect(storage.putBlob(bytes("12345"))).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(existsSync(objectsDir(home))).toBe(false);
  });
});

describe("FileStorage garbage collection", () => {
  test("deletes only blobs the caller does not keep", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    const kept = await storage.putBlob(bytes("kept"));
    const dropped = await storage.putBlob(bytes("dropped"));

    expect(await storage.gc([kept.id])).toEqual([dropped.id]);
    expect(await storage.getBlob(kept.id)).toBeDefined();
    expect(await storage.getBlob(dropped.id)).toBeUndefined();
  });

  test("keeps blobs referenced by stored records", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    const referenced = await storage.putBlob(bytes("before-image"));
    const unreferenced = await storage.putBlob(bytes("orphan"));
    await storage.saveRecord(v3Record({ mutated: [{ path: "/home/.zshrc", beforeBlob: referenced.id }] }));

    expect(await storage.gcUnreferenced()).toEqual([unreferenced.id]);
    expect(await storage.getBlob(referenced.id)).toBeDefined();
    expect(await storage.getBlob(unreferenced.id)).toBeUndefined();
  });

  test("is idempotent, so a repeated or interrupted run is safe", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    await storage.putBlob(bytes("orphan"));

    expect((await storage.gcUnreferenced()).length).toBe(1);
    expect(await storage.gcUnreferenced()).toEqual([]);
    expect(await storage.gc([])).toEqual([]);
  });

  test("removes stray temp files from an interrupted write without reporting them as blobs", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });
    const similar = await storage.putBlob(bytes("kept"));
    const stale = join(objectsDir(home), `${similar.id}.999.tmp`);
    writeFileSync(stale, "partial");

    expect(await storage.gc([similar.id])).toEqual([]);
    expect(existsSync(stale)).toBe(false);
    expect(await storage.getBlob(similar.id)).toBeDefined();
  });

  test("returns nothing when the objects directory does not exist", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home });

    expect(await storage.gc([])).toEqual([]);
  });

  test("spares a blob written inside the grace window and removes it once aged", async () => {
    const home = makeHome();
    const storage = new FileStorage({ homeDir: home, gcGraceMs: 60_000 });
    const blob = await storage.putBlob(bytes("in-flight"));
    const temp = join(objectsDir(home), "interrupted.tmp");
    writeFileSync(temp, "partial");

    expect(await storage.gc([])).toEqual([]);
    expect(await storage.getBlob(blob.id)).toBeDefined();
    expect(existsSync(temp)).toBe(true);

    const past = new Date(Date.now() - 3_600_000);
    utimesSync(blobPath(home, blob.id), past, past);
    utimesSync(temp, past, past);

    expect(await storage.gc([])).toEqual([blob.id]);
    expect(await storage.getBlob(blob.id)).toBeUndefined();
    expect(existsSync(temp)).toBe(false);
  });
});
