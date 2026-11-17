import { OPERATION_CHUNK_BYTES, OPERATION_INLINE_BYTES, type OperationEnvelope } from "./operation-chunks";
import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { FileStorage } from "./store";
import { NativeDirectory } from "./native-filesystem";
import { OperationLog } from "./operation-log";
import type { RecordV3 } from "../types";
import { RecoveryRetentionError } from "./recovery-retention";
import { join } from "node:path";
import { purgeDiscarded } from "./recovery-originals";
import { tmpdir } from "node:os";
import { withOperationLease } from "./operation-lease";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-operation-chunks-"));
  roots.push(root);
  return new OperationLog(root);
}
const parts = (log: OperationLog) => readdirSync(log.directory).filter((name) => name.endsWith(".part"));
const baseline = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ path: `/scope/${index}/${"x".repeat(900)}`, kind: "file" as const }));

test("a greater-than-16-MiB baseline roundtrips through bounded immutable parts", async () => {
  const log = fixture();
  await withOperationLease(log.stateDir, async () => {
    let op = log.begin("install");
    op = log.checkpoint(op, {
      stage: "running",
      baseline: baseline(20_000),
      unknownSince: new Date().toISOString(),
      pins: ["a".repeat(64)],
    });
    expect(log.get(op.id)).toEqual(op);
    const path = join(log.directory, `${op.id}.json`);
    expect(lstatSync(path).size).toBeLessThan(OPERATION_INLINE_BYTES);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
    expect(parts(log).length).toBeGreaterThan(16);
    for (const name of parts(log)) {
      const stat = lstatSync(join(log.directory, name));
      expect(stat.size).toBeLessThanOrEqual(OPERATION_CHUNK_BYTES);
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const count = parts(log).length;
    op = log.checkpoint(op, { stage: "captured" });
    expect(parts(log).length).toBeLessThanOrEqual(count + 2);
    op = log.checkpoint(op, { stage: "completed" });
    expect(log.pinnedBlobs()).toContain("a".repeat(64));
    expect(log.get(op.id)).toEqual(op);
    log.discard(op.id);
    expect(parts(log)).toEqual([]);
    expect(log.pinnedBlobs()).toEqual([]);
    expect(purgeDiscarded(log, op.id).purged).toBe(true);
  });
});

test("failed root publication keeps the last cursor; unpublished parts prevent GC until explicit discard", async () => {
  const log = fixture();
  await withOperationLease(log.stateDir, async () => {
    const initial = log.begin("install");
    const op = log.checkpoint(initial, { stage: "running", unknownSince: new Date().toISOString() });
    const path = join(log.directory, `${op.id}.json`);
    const before = readFileSync(path);
    const write = log.retention.beforeWrite.bind(log.retention);
    log.retention.beforeWrite = (name, size) => {
      if (name === path) throw new RecoveryRetentionError("injected publication failure");
      write(name, size);
    };
    try {
      expect(() => log.checkpoint(op, { baseline: baseline(1500), pins: ["b".repeat(64)] })).toThrow(
        "injected publication failure",
      );
    } finally {
      log.retention.beforeWrite = write;
    }
    expect(readFileSync(path)).toEqual(before);
    expect(log.get(op.id)).toEqual(op);
    expect(parts(log).length).toBeGreaterThan(0);
    expect(() => log.pinnedBlobs()).toThrow("unpublished operation chunk");
    log.discard(op.id);
    expect(log.pinnedBlobs()).toEqual([]);
    expect(parts(log)).toEqual([]);
  });
});

test.each(["missing", "changed", "symlink"])("a %s payload part fails closed without replacing any evidence", async (fault) => {
  const log = fixture();
  await withOperationLease(log.stateDir, async () => {
    const op = log.checkpoint(log.begin("install"), { baseline: baseline(500), stage: "running" });
    const path = join(log.directory, parts(log)[0]!);
    const bytes = readFileSync(join(log.directory, `${op.id}.json`));
    if (fault === "changed") writeFileSync(path, "foreign bytes");
    else {
      rmSync(path);
      if (fault === "symlink") {
        const foreign = join(log.stateDir, "foreign");
        writeFileSync(foreign, "foreign bytes");
        symlinkSync(foreign, path);
      }
    }
    expect(() => log.get(op.id)).toThrow();
    expect(() => log.pinnedBlobs()).toThrow();
    expect(readFileSync(join(log.directory, `${op.id}.json`))).toEqual(bytes);
  });
});

test("discard publishes before chunk deletion, and purge retries a failed unlink above a lowered quota", async () => {
  const log = fixture();
  await withOperationLease(log.stateDir, async () => {
    const op = log.checkpoint(log.begin("install"), { baseline: baseline(500) });
    const unlink = NativeDirectory.prototype.unlink;
    NativeDirectory.prototype.unlink = function () {
      throw new Error("injected chunk unlink failure");
    };
    try {
      expect(() => log.discard(op.id)).toThrow("injected chunk unlink failure");
    } finally {
      NativeDirectory.prototype.unlink = unlink;
    }
    expect(log.get(op.id)?.stage).toBe("discarded");
    expect(parts(log).length).toBeGreaterThan(0);
    const prior = process.env.TRET_RECOVERY_MAX_BYTES;
    process.env.TRET_RECOVERY_MAX_BYTES = "1";
    try {
      expect(purgeDiscarded(log, op.id).purged).toBe(true);
      expect(parts(log)).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.TRET_RECOVERY_MAX_BYTES;
      else process.env.TRET_RECOVERY_MAX_BYTES = prior;
    }
  });
});

test("legacy v1 is read without migration; invalid v2 envelope lengths never become empty evidence", async () => {
  const log = fixture();
  await withOperationLease(log.stateDir, async () => {
    const op = { ...log.begin("install"), version: 1 as const };
    const path = join(log.directory, `${op.id}.json`);
    writeFileSync(path, JSON.stringify(op));
    const before = readFileSync(path);
    expect(log.get(op.id)).toEqual(op);
    expect(readFileSync(path)).toEqual(before);
    const next = log.checkpoint(op, { stage: "running" });
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    expect(envelope.version).toBe(2);
    envelope.bytes++;
    writeFileSync(path, JSON.stringify(envelope));
    expect(() => log.get(next.id)).toThrow("invalid inline operation length");
  });
});

test.each(["maxBytes", "maxEntries"] as const)(
  "chunk writes honor %s and leave an addressable prior intent",
  async (resource) => {
    const original = fixture();
    const limits = {
      maxBytes: 128 * 1024 * 1024,
      maxEntries: 1024,
      maxWorkMs: 30_000,
      [resource]: resource === "maxBytes" ? 2 * 1024 * 1024 : 3,
    };
    const log = new OperationLog(original.stateDir, limits);
    await withOperationLease(log.stateDir, async () => {
      const op = log.checkpoint(log.begin("install"), { stage: "running" });
      let error: unknown;
      try {
        log.checkpoint(op, { baseline: baseline(4000) });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RecoveryRetentionError);
      expect((error as RecoveryRetentionError).executionMayHaveStarted).toBe(true);
      expect(log.get(op.id)).toEqual(op);
      if (resource === "maxBytes") {
        expect((error as Error).message).toContain("logical");
        expect(parts(log)).toEqual([]);
      } else expect(parts(log).length).toBeGreaterThan(0);
      expect(log.unpublishedChunks().length).toBe(parts(log).length);
      log.discard(op.id);
      expect(parts(log)).toEqual([]);
    });
  },
);

test("retained generations pin recovery blobs until explicit discard, preserving active targets", async () => {
  const log = fixture();
  const store = new FileStorage({ homeDir: log.stateDir, gcGraceMs: 0 });
  const blob = await store.putBlob(new TextEncoder().encode("historical before image"));
  const target = join(log.stateDir, "user-target");
  writeFileSync(target, "keep");
  await store.withOperation(async () => {
    let op = store.operations.checkpoint(store.operations.begin("install"), {
      baseline: baseline(500),
      pins: [blob.id],
      stage: "running",
    });
    op = store.operations.checkpoint(op, { stage: "captured" });
    op = store.operations.checkpoint(op, { stage: "completed" });
    expect(op.pins).toEqual([blob.id]);
    expect(await store.gcUnreferenced()).toEqual([]);
    store.operations.discard(op.id);
    expect(await store.gcUnreferenced()).toEqual([blob.id]);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});

test("SIGKILL before chunk-root publication retains the durable unknown interval and an addressable owner", async () => {
  const log = fixture();
  const code = `
    import { OperationLog } from ${JSON.stringify(join(import.meta.dir, "operation-log.ts"))};
    import { withOperationLease } from ${JSON.stringify(join(import.meta.dir, "operation-lease.ts"))};
    const log = new OperationLog(${JSON.stringify(log.stateDir)});
    await withOperationLease(log.stateDir, async () => {
      const op = log.checkpoint(log.begin("install"), { stage: "running", unknownSince: new Date().toISOString() });
      const before = log.retention.beforeWrite.bind(log.retention);
      log.retention.beforeWrite = (path, size) => {
        if (path.endsWith('.json')) process.kill(process.pid, 'SIGKILL');
        before(path, size);
      };
      log.checkpoint(op, { baseline: Array.from({length: 500}, (_, i) => ({path: '/scope/' + i + '/' + 'x'.repeat(900), kind: 'file'})) });
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", code], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stdout, stderr }).toEqual({ exit: 137, stdout: "", stderr: "" });
  const op = log.list()[0]!;
  expect(op.stage).toBe("running");
  expect(op.unknownSince).toBeDefined();
  expect(op.baseline).toBeUndefined();
  expect(log.unpublishedChunks().length).toBeGreaterThan(0);
  await withOperationLease(log.stateDir, async () => {
    expect(() => log.begin("install")).toThrow("unfinished operations");
    log.discard(op.id);
    expect(parts(log)).toEqual([]);
  });
});

test("failed initial large snapshot leaves a small prepared intent instead of ownerless chunks", async () => {
  const log = fixture();
  const record: RecordV3 = {
    id: "large-prior",
    name: "large-prior",
    source: "install",
    installedAt: "2026-11-15",
    executable: "/scope/tool",
    url: "https://example.com/install.sh",
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-15" }] },
    owned: baseline(500),
    mutated: [],
    deleted: [],
  };
  await withOperationLease(log.stateDir, async () => {
    const write = log.retention.beforeWrite.bind(log.retention);
    let roots = 0;
    log.retention.beforeWrite = (path, size) => {
      if (path.endsWith(".json") && ++roots === 2)
        throw new RecoveryRetentionError("injected initial snapshot publication failure");
      write(path, size);
    };
    try {
      expect(() => log.begin("replace", [record])).toThrow("injected initial snapshot");
    } finally {
      log.retention.beforeWrite = write;
    }
    const op = log.list()[0]!;
    expect(op.stage).toBe("prepared");
    expect(op.priorRecords).toEqual([]);
    expect(parts(log).length).toBeGreaterThan(0);
    expect(log.unpublishedChunks().length).toBe(parts(log).length);
    log.discard(op.id);
    expect(parts(log)).toEqual([]);
  });
});

test("a partial unpublished chunk remains named after discard while verified own chunks are cleaned", async () => {
  const log = fixture();
  await withOperationLease(log.stateDir, async () => {
    const op = log.checkpoint(log.begin("install"), { stage: "running", baseline: baseline(500) });
    const broken = join(log.directory, `${op.id}.${"0".repeat(64)}.part`);
    writeFileSync(broken, "interrupted partial write", { mode: 0o600 });
    expect(() => log.discard(op.id)).toThrow("unverified operation chunk retained");
    expect(log.get(op.id)?.stage).toBe("discarded");
    expect(parts(log)).toEqual([broken.split("/").at(-1)!]);
    expect(log.unpublishedChunks().map((entry) => entry.path)).toEqual([broken]);
    expect(log.pinnedBlobs()).toEqual([]);
    expect(() => purgeDiscarded(log, op.id)).toThrow("unverified operation chunk retained");
    expect(readFileSync(broken, "utf8")).toBe("interrupted partial write");
  });
});

test("the per-operation retained chunk cap still applies above aggregate entry and byte limits", async () => {
  const original = fixture();
  const log = new OperationLog(original.stateDir, { maxBytes: 2 * 1024 ** 3, maxEntries: 4096, maxWorkMs: 30_000 });
  await withOperationLease(log.stateDir, async () => {
    let op = log.begin("install");
    const path = join(log.directory, `${op.id}.json`);
    const envelope: OperationEnvelope = JSON.parse(readFileSync(path, "utf8"));
    // Seed small, valid historical encodings to reach the count boundary without GiB of test I/O.
    envelope.retained = Array.from({ length: 1023 }, (_, i) => {
      const bytes = Buffer.from(`previous encoding ${i}`);
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      writeFileSync(join(log.directory, `${op.id}.${hash}.part`), bytes, { mode: 0o600 });
      return { hash, bytes: bytes.byteLength };
    });
    writeFileSync(path, JSON.stringify(envelope));
    op = log.checkpoint(op, { baseline: baseline(500) });
    expect(parts(log).length).toBe(1024);
    const before = readFileSync(path);
    expect(() => log.checkpoint(op, { reason: "a distinct encoding" })).toThrow("retained chunk limit 1024");
    expect(readFileSync(path)).toEqual(before);
    expect(log.get(op.id)).toEqual(op);
    log.discard(op.id);
    expect(parts(log)).toEqual([]);
  });
});
