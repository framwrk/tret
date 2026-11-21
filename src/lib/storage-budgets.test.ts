import { CaptureBudgetError, DEFAULT_CAPTURE_LIMITS } from "./capture/budget";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "./store";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(maxStoreBytes = 8, maxBlobBytes = 8) {
  const home = mkdtempSync(join(tmpdir(), "tret-storage-budget-"));
  roots.push(home);
  const store = new FileStorage({
    homeDir: home,
    backups: { enabled: true, sizeLimitBytes: 1024 },
    limits: { ...DEFAULT_CAPTURE_LIMITS, maxStoreBytes, maxBlobBytes },
  });
  return { home, store };
}
test("aggregate store exhaustion refuses new blobs while retaining all existing bytes", async () => {
  const { store } = fixture();
  const first = await store.putBlob(new TextEncoder().encode("first"));
  const bytes = readFileSync(join(store.objectsDir, first.id));
  await expect(store.putBlob(new TextEncoder().encode("second"))).rejects.toBeInstanceOf(CaptureBudgetError);
  expect(readFileSync(join(store.objectsDir, first.id))).toEqual(bytes);
  expect(await store.getBlob(first.id)).toEqual(bytes);
});
test("deduplication still works at a full store without allocating more storage", async () => {
  const { store } = fixture(5);
  const bytes = new TextEncoder().encode("first");
  const first = await store.putBlob(bytes);
  expect(await store.putBlob(bytes)).toEqual(first);
});

test("capture node limits do not limit the number of retained blobs", async () => {
  const { home } = fixture();
  const store = new FileStorage({ homeDir: home, limits: { ...DEFAULT_CAPTURE_LIMITS, maxNodes: 1 } });
  for (const value of ["one", "two", "three"]) await store.putBlob(new TextEncoder().encode(value));
});
test("a single-blob ceiling also bounds direct and legacy blob reads", async () => {
  const { home, store } = fixture();
  const blob = await store.putBlob(new TextEncoder().encode("123456"));
  const bounded = new FileStorage({ homeDir: home, limits: { ...DEFAULT_CAPTURE_LIMITS, maxBlobBytes: 4 } });
  await expect(bounded.getBlob(blob.id)).rejects.toThrow("exceeds 4 bytes");
  expect(existsSync(join(store.objectsDir, blob.id))).toBe(true);
});

test("a before-image batch scans retained bytes once and counts only new blobs", async () => {
  const { store } = fixture(8);
  const scan = spyOn(store as unknown as { objectBytes: () => number }, "objectBytes");
  const encoder = new TextEncoder();
  const first = encoder.encode("first");
  const second = encoder.encode("two");
  const excess = encoder.encode("x");
  await expect(store.putBlobs([first, first, second, excess])).rejects.toBeInstanceOf(CaptureBudgetError);
  expect(scan).toHaveBeenCalledTimes(1);
  const id = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(await store.getBlob(id(first))).toEqual(first);
  expect(await store.getBlob(id(second))).toEqual(second);
  expect(await store.getBlob(id(excess))).toBeUndefined();
});

test("a before-image batch reclaims corrupt bytes only after staging their replacement", async () => {
  const { store } = fixture(8);
  const first = new TextEncoder().encode("one");
  const { id } = await store.putBlob(first);
  writeFileSync(join(store.objectsDir, id), "wrong");
  const second = new TextEncoder().encode("later");
  const [, storedSecond] = await store.putBlobs([first, second]);
  expect(await store.getBlob(id)).toEqual(first);
  expect(await store.getBlob(storedSecond!.id)).toEqual(second);
});
