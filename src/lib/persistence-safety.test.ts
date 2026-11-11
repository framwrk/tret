import { FileStorage, RecordsCorruptionError, RecordsLockedError } from "./store";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFileIfExists, writeFileAtomic } from "./atomic";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
const atomic = join(import.meta.dir, "atomic.ts");
const store = join(import.meta.dir, "store.ts");

afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "tret-persistence-"));
  homes.push(root);
  return root;
}

function record(): RecordV3 {
  return {
    id: "fixture",
    name: "fixture",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: new Date(0).toISOString(),
    executable: "",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "fixture",
      completeness: "partial",
      segments: [{ kind: "install", startedAt: new Date(0).toISOString() }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
  };
}

function seedLegacy(root: string): { path: string; bytes: string } {
  const path = join(root, ".tret/records.json");
  mkdirSync(join(root, ".tret"));
  const bytes = JSON.stringify(
    {
      version: 2,
      records: [
        {
          name: "old",
          source: "install",
          url: "https://example.com/old.sh",
          installedAt: new Date(0).toISOString(),
          executable: "/fixture/old",
          scriptSha256: "a".repeat(64),
          added: ["/fixture/old"],
          edited: [],
        },
      ],
    },
    null,
    4,
  );
  writeFileSync(path, bytes);
  return { path, bytes };
}

async function probe(root: string, source: string): Promise<void> {
  const path = join(root, "probe.ts");
  writeFileSync(path, source);
  const child = Bun.spawn([process.execPath, path, root], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(4000),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}

test("reading legacy records never rewrites their original bytes", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  const storage = new FileStorage({ homeDir: root });
  expect((await storage.loadRecords())[0]?.capture.backend).toBe("legacy-v2");
  expect(readFileSync(legacy.path, "utf8")).toBe(legacy.bytes);
  expect(readdirSync(join(root, ".tret"))).toEqual(["records.json"]);
});

test("list and inspect preserve legacy record bytes and do not persist migration", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  for (const args of [
    ["list", "--json"],
    ["inspect", "old", "--json"],
  ]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../index.ts"), ...args], {
      env: { ...process.env, HOME: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.bytes);
  }
  expect(readdirSync(join(root, ".tret")).filter((name) => name.includes(".legacy-"))).toEqual([]);
});

test("a legacy write preserves an owner-only original before replacing the records", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  const storage = new FileStorage({ homeDir: root });
  await storage.saveRecord(record());
  const saved = readdirSync(join(root, ".tret")).filter((name) => name.startsWith("records.json.legacy-v2-"));
  expect(saved).toHaveLength(1);
  const path = join(root, ".tret", saved[0]!);
  expect(readFileSync(path, "utf8")).toBe(legacy.bytes);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(await storage.loadRecords()).toHaveLength(2);
});

test("a matching original from an interrupted migration is reused without replacing it", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  const digest = new Bun.CryptoHasher("sha256").update(legacy.bytes).digest("hex");
  const backup = `${legacy.path}.legacy-v2-${digest}.json`;
  writeFileSync(backup, legacy.bytes, { mode: 0o644 });
  const inode = statSync(backup).ino;
  await new FileStorage({ homeDir: root }).saveRecord(record());
  expect(statSync(backup).ino).toBe(inode);
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  expect(readFileSync(backup, "utf8")).toBe(legacy.bytes);
});

test("a failed original-backup write leaves the legacy record unchanged", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  const digest = new Bun.CryptoHasher("sha256").update(legacy.bytes).digest("hex");
  mkdirSync(`${legacy.path}.legacy-v2-${digest}.json`);
  await expect(new FileStorage({ homeDir: root }).saveRecord(record())).rejects.toThrow();
  expect(readFileSync(legacy.path, "utf8")).toBe(legacy.bytes);
  expect(existsSync(`${legacy.path}.lock`)).toBe(false);
});

test("a mismatched retained original blocks migration without replacing either file", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  const digest = new Bun.CryptoHasher("sha256").update(legacy.bytes).digest("hex");
  const backup = `${legacy.path}.legacy-v2-${digest}.json`;
  writeFileSync(backup, "earlier recovery evidence");
  await expect(new FileStorage({ homeDir: root }).saveRecord(record())).rejects.toThrow("does not match");
  expect(readFileSync(legacy.path, "utf8")).toBe(legacy.bytes);
  expect(readFileSync(backup, "utf8")).toBe("earlier recovery evidence");
  expect(existsSync(`${legacy.path}.lock`)).toBe(false);
});

for (const target of ["lock", "original"] as const) {
  test(`failed ${target} creation removes its partial file and allows a successful retry`, async () => {
    for (const phase of ["write", "chmod", "file-flush", "directory-flush"]) {
      const root = home();
      const legacy = target === "original" ? seedLegacy(root) : undefined;
      await probe(
        root,
        `import * as fs from "node:fs";
import { mock } from "bun:test";
const real = { ...fs };
const paths = new Map();
const target = ${JSON.stringify(target)};
const phase = ${JSON.stringify(phase)};
let active = false;
let injected = false;
let partial = false;
const selected = (fd) => target === "lock" ? paths.get(fd)?.endsWith(".lock") : paths.get(fd)?.includes(".legacy-v2-");
const fail = () => { injected = true; throw new Error("synthetic exclusive-write failure"); };
mock.module("node:fs", () => ({
  ...real,
  openSync: (...args) => { const fd = real.openSync(...args); paths.set(fd, args[0]); if (selected(fd)) active = true; return fd; },
  closeSync: (fd) => { paths.delete(fd); return real.closeSync(fd); },
  fchmodSync: (fd, mode) => { if (!injected && selected(fd) && phase === "chmod") fail(); return real.fchmodSync(fd, mode); },
  writeSync: (fd, bytes, offset = 0, length = bytes.length - offset) => {
    if (!injected && selected(fd) && phase === "write") {
      if (partial) fail();
      partial = true;
      return real.writeSync(fd, bytes, offset, Math.min(2, length));
    }
    return real.writeSync(fd, bytes, offset, length);
  },
  fsyncSync: (fd) => {
    if (!injected && active && ((phase === "file-flush" && selected(fd)) || (phase === "directory-flush" && real.fstatSync(fd).isDirectory()))) fail();
    return real.fsyncSync(fd);
  },
}));
const { FileStorage } = await import(${JSON.stringify(store)});
const storage = new FileStorage({ homeDir: process.argv[2], lockTimeoutMs: 25 });
const record = ${JSON.stringify(record())};
try { await storage.saveRecord(record); throw new Error("expected failure"); }
catch (error) { if (error.message !== "synthetic exclusive-write failure") throw error; }
if (!injected) throw new Error("failure was not injected");
if (real.existsSync(process.argv[2] + "/.tret/records.json.lock")) throw new Error("partial lock remains");
if (real.readdirSync(process.argv[2] + "/.tret").some((name) => name.includes(".legacy-v2-"))) throw new Error("partial original remains");
${legacy ? `if (real.readFileSync(process.argv[2] + "/.tret/records.json", "utf8") !== ${JSON.stringify(legacy.bytes)}) throw new Error("original records changed");` : `if (real.existsSync(process.argv[2] + "/.tret/records.json")) throw new Error("unexpected records");`}
await storage.saveRecord(record);
if (!(await storage.loadRecords()).some((entry) => entry.id === record.id)) throw new Error("retry failed");
`,
      );
    }
  });
}

test("an old lock owned by a live process is never stolen", async () => {
  const root = home();
  mkdirSync(join(root, ".tret"));
  const lock = join(root, ".tret/records.json.lock");
  const owner = `${process.pid}\n`;
  writeFileSync(lock, owner);
  const past = new Date(Date.now() - 60_000);
  utimesSync(lock, past, past);
  await expect(new FileStorage({ homeDir: root, lockTimeoutMs: 25 }).saveRecord(record())).rejects.toBeInstanceOf(
    RecordsLockedError,
  );
  expect(readFileSync(lock, "utf8")).toBe(owner);
  expect(existsSync(join(root, ".tret/records.json"))).toBe(false);
});

test("releasing a records lock preserves a replacement lease", async () => {
  const root = home();
  const storage = new FileStorage({ homeDir: root });
  const load = storage.loadRecords.bind(storage);
  const lock = join(root, ".tret/records.json.lock");
  storage.loadRecords = async () => {
    const records = await load();
    rmSync(lock);
    writeFileSync(lock, "replacement lease\n");
    return records;
  };
  await storage.saveRecord(record());
  expect(readFileSync(lock, "utf8")).toBe("replacement lease\n");
});

test("quarantined records prevent empty-store garbage collection from destroying recovery blobs", async () => {
  const root = home();
  const storage = new FileStorage({ homeDir: root });
  const blob = await storage.putBlob(new TextEncoder().encode("recovery bytes"));
  writeFileSync(join(root, ".tret/records.json"), "corrupt record with unknown references");
  await storage.quarantineCorruptRecords();
  expect(await storage.gcUnreferenced()).toEqual([]);
  expect(new TextDecoder().decode(await storage.getBlob(blob.id))).toBe("recovery bytes");
});

test("a legacy original does not pin blobs its format cannot reference", async () => {
  const root = home();
  const legacy = seedLegacy(root);
  const storage = new FileStorage({ homeDir: root });
  await storage.saveRecord(record());
  const orphan = await storage.putBlob(new TextEncoder().encode("orphan bytes"));
  expect(await storage.gcUnreferenced()).toEqual([orphan.id]);
  const original = readdirSync(join(root, ".tret")).find((name) => name.includes(".legacy-v2-"))!;
  expect(readFileSync(join(root, ".tret", original), "utf8")).toBe(legacy.bytes);
});

test("quarantine cannot slip between the GC recovery check and reference read", async () => {
  const root = home();
  const storage = new FileStorage({ homeDir: root });
  const blob = await storage.putBlob(new TextEncoder().encode("recovery bytes"));
  writeFileSync(join(root, ".tret/records.json"), "corrupt records with unknown references");
  const collector = new FileStorage({ homeDir: root });
  const load = collector.loadRecords.bind(collector);
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  collector.loadRecords = async () => {
    ready.resolve();
    await resume.promise;
    return load();
  };
  const sweep = collector.gcUnreferenced().catch((error: unknown) => {
    expect(error).toBeInstanceOf(RecordsCorruptionError);
    return [];
  });
  await ready.promise;
  const quarantine = storage.quarantineCorruptRecords();
  await Bun.sleep(30);
  resume.resolve();
  await Promise.all([sweep, quarantine]);
  expect(new TextDecoder().decode(await storage.getBlob(blob.id))).toBe("recovery bytes");
});

test("quarantine cannot overwrite an earlier recovery file with the same timestamp", async () => {
  const root = home();
  mkdirSync(join(root, ".tret"));
  const path = join(root, ".tret/records.json");
  const backup = `${path}.corrupt-1970-01-01T00-00-00-000Z`;
  writeFileSync(path, "current corrupt bytes");
  writeFileSync(backup, "earlier recovery bytes");
  await expect(new FileStorage({ homeDir: root, now: () => 0 }).quarantineCorruptRecords()).rejects.toThrow("already exists");
  expect(readFileSync(path, "utf8")).toBe("current corrupt bytes");
  expect(readFileSync(backup, "utf8")).toBe("earlier recovery bytes");
});

test("private reads refuse final symlinks instead of following them", () => {
  const root = home();
  const sentinel = join(root, "sentinel");
  const link = join(root, "records.json");
  writeFileSync(sentinel, "synthetic private data");
  symlinkSync(sentinel, link);
  expect(() => readFileIfExists(link)).toThrow();
  expect(readFileSync(sentinel, "utf8")).toBe("synthetic private data");
});

test("private reads reject a FIFO without blocking", async () => {
  const root = home();
  const fifo = join(root, "fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  await probe(
    root,
    `import { readFileIfExists } from ${JSON.stringify(atomic)};
try { readFileIfExists(process.argv[2] + "/fifo"); throw new Error("expected refusal"); }
catch (error) { if (!error.message.includes("not a regular file")) throw error; }
`,
  );
});

test("a symlinked blob directory cannot redirect garbage collection", async () => {
  const root = home();
  mkdirSync(join(root, ".tret"));
  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated);
  const id = new Bun.CryptoHasher("sha256").update("sentinel").digest("hex");
  writeFileSync(join(unrelated, id), "sentinel");
  symlinkSync(unrelated, join(root, ".tret/objects"));
  await expect(new FileStorage({ homeDir: root }).gc([])).rejects.toThrow();
  expect(readFileSync(join(unrelated, id), "utf8")).toBe("sentinel");
});

test("private writes reject a symlinked destination directory without tightening its target", () => {
  const root = home();
  const outside = join(root, "unrelated");
  mkdirSync(outside, { mode: 0o755 });
  symlinkSync(outside, join(root, ".tret"));
  expect(() => writeFileAtomic(join(root, ".tret/records.json"), "new", 0o600)).toThrow();
  expect(statSync(outside).mode & 0o777).toBe(0o755);
  expect(existsSync(join(outside, "records.json"))).toBe(false);
});

test("predictable temporary-file symlinks cannot redirect an atomic write", async () => {
  const root = home();
  await probe(
    root,
    `import { symlinkSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from ${JSON.stringify(atomic)};
const root = process.argv[2];
const target = root + "/records.json";
writeFileSync(root + "/sentinel", "original");
symlinkSync(root + "/sentinel", target + "." + process.pid + ".1.tmp");
writeFileAtomic(target, "replacement", 0o600);
`,
  );
  expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("original");
  expect(readFileSync(join(root, "records.json"), "utf8")).toBe("replacement");
});

test("atomic writes handle short writes without publishing truncated records", async () => {
  const root = home();
  await probe(
    root,
    `import * as fs from "node:fs";
import { mock } from "bun:test";
const write = fs.writeSync;
mock.module("node:fs", () => ({ ...fs, writeSync: (fd, bytes, offset = 0, length = bytes.length - offset) => write(fd, bytes, offset, Math.min(2, length)) }));
const { writeFileAtomic } = await import(${JSON.stringify(atomic)});
writeFileAtomic(process.argv[2] + "/records.json", "complete payload", 0o600);
`,
  );
  expect(readFileSync(join(root, "records.json"), "utf8")).toBe("complete payload");
});

test("a failed atomic write leaves the previous file and cleans its private temporary file", async () => {
  const root = home();
  writeFileSync(join(root, "records.json"), "original");
  await probe(
    root,
    `import * as fs from "node:fs";
import { mock } from "bun:test";
mock.module("node:fs", () => ({ ...fs, writeSync: () => { throw new Error("synthetic storage full"); } }));
const { writeFileAtomic } = await import(${JSON.stringify(atomic)});
try { writeFileAtomic(process.argv[2] + "/records.json", "replacement", 0o600); throw new Error("expected write failure"); }
catch (error) { if (error.message !== "synthetic storage full") throw error; }
`,
  );
  expect(readFileSync(join(root, "records.json"), "utf8")).toBe("original");
  expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
