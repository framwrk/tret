import { FileStorage, RecordRevisionError } from "./store";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-revisions-"));
  homes.push(home);
  const storage = new FileStorage({ homeDir: home });
  const record: RecordV3 = {
    id: "fixture",
    name: "fixture",
    source: "find",
    url: "",
    installedAt: "2026-11-11",
    executable: "",
    scriptSha256: "",
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    capture: { backend: "find", completeness: "heuristic", segments: [{ kind: "find", startedAt: "2026-11-11" }] },
  };
  return { home, storage, record };
}

test("stale saves and removals preserve the newer revision byte for byte", async () => {
  const { storage, record } = fixture();
  const first = await storage.saveRecord(record);
  const second = await storage.saveRecord({ ...first, name: "newer" });
  const bytes = readFileSync(storage.recordsPath);
  await expect(storage.saveRecord({ ...first, name: "stale" })).rejects.toBeInstanceOf(RecordRevisionError);
  await expect(storage.removeRecord(first.id, first.revision)).rejects.toBeInstanceOf(RecordRevisionError);
  expect(readFileSync(storage.recordsPath)).toEqual(bytes);
  expect((await storage.loadRecords())[0]?.revision).toBe(second.revision);
});

test("delete/recreate advances the store sequence and cannot revive a stale claim", async () => {
  const { storage, record } = fixture();
  const first = await storage.saveRecord(record);
  await storage.removeRecord(first.id, first.revision);
  const replacement = await storage.saveRecord({ ...record, name: "replacement" });
  expect(replacement.revision).toBeGreaterThan(first.revision + 1);
  await expect(storage.saveRecord(first)).rejects.toBeInstanceOf(RecordRevisionError);
  expect((await storage.loadRecords())[0]?.name).toBe("replacement");
});

test("a retained v3 original pins its before-images after active claims are forgotten", async () => {
  const { storage, record } = fixture();
  const blob = await storage.putBlob(new TextEncoder().encode("before"));
  const path = join(storage.homeDir, "config");
  const original = JSON.stringify({ version: 3, records: [{ ...record, mutated: [{ path, beforeBlob: blob.id }] }] });
  writeFileSync(storage.recordsPath, original);
  const legacy = (await storage.loadRecords())[0]!;
  await storage.removeRecord(legacy.id, legacy.revision);
  expect(await storage.gcUnreferenced()).toEqual([]);
  expect(await storage.getBlob(blob.id)).toEqual(new TextEncoder().encode("before"));
});

test("operation pins precede blob creation and survive explicit recovery until discarded", async () => {
  const { storage } = fixture();
  const bytes = new TextEncoder().encode("available before image");
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  let operationId = "";
  await storage.withOperation(async () => {
    const operation = storage.operations.begin("install");
    operationId = operation.id;
    storage.operations.checkpoint(operation, { pins: [id], stage: "running" });
    await storage.putBlob(bytes);
  });
  expect(await storage.gcUnreferenced()).toEqual([]);
  expect(await storage.gc([])).toEqual([]);
  await storage.withOperation(async () => {
    storage.operations.discard(operationId);
  }, true);
  expect(await storage.gcUnreferenced()).toEqual([id]);
});

test("v4 transactions use the kernel lease and preserve an obsolete migration lease without relying on it", async () => {
  const { storage, record } = fixture();
  const first = await storage.saveRecord(record);
  const legacyLease = `${storage.recordsPath}.lock`;
  writeFileSync(legacyLease, "obsolete migration lease\n");
  const second = await storage.saveRecord({ ...first, name: "updated under kernel lease" });
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(readFileSync(legacyLease, "utf8")).toBe("obsolete migration lease\n");
});
