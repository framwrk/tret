import { describe, expect, test } from "bun:test";
import type { RecordV3 } from "../types";
import type { Storage } from "./storage";
import { referencedBlobs } from "./storage";

/** A minimal in-memory Storage that proves the contract is implementable; the real one is phase 6. */
class MemoryStorage implements Storage {
  private readonly blobs = new Map<string, Uint8Array>();
  private records: RecordV3[] = [];

  async loadRecords(): Promise<RecordV3[]> {
    return [...this.records];
  }

  async saveRecord(record: RecordV3): Promise<void> {
    this.records = this.records.filter((existing) => existing.id !== record.id);
    this.records.push(record);
  }

  async removeRecord(id: string): Promise<void> {
    this.records = this.records.filter((existing) => existing.id !== id);
  }

  async putBlob(content: Uint8Array): Promise<{ id: string; size: number }> {
    const id = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    this.blobs.set(id, content);
    return { id, size: content.byteLength };
  }

  async getBlob(id: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(id);
  }

  async gc(keep: Iterable<string>): Promise<string[]> {
    const kept = new Set(keep);
    const removed: string[] = [];
    for (const id of [...this.blobs.keys()]) {
      if (!kept.has(id)) {
        this.blobs.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
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
      backend: "linux-fanotify",
      completeness: "complete",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path: "/home/.local/bin/mytool", kind: "file", installedHash: "b".repeat(64) }],
    mutated: [{ path: "/home/.zshrc", beforeHash: "c".repeat(64), installedHash: "d".repeat(64), beforeBlob: "blob-1" }],
    deleted: [{ path: "/home/.old", beforeHash: "e".repeat(64), beforeBlob: "blob-2" }],
    ...overrides,
  };
}

describe("storage contract", () => {
  test("records round-trip through the Storage interface", async () => {
    const storage = new MemoryStorage();
    await storage.saveRecord(record());

    expect(await storage.loadRecords()).toEqual([record()]);

    await storage.removeRecord("rec-1");
    expect(await storage.loadRecords()).toEqual([]);
  });

  test("blobs are content-addressed and deduplicated by content", async () => {
    const storage = new MemoryStorage();
    const bytes = new TextEncoder().encode("before-image contents");

    const first = await storage.putBlob(bytes);
    const second = await storage.putBlob(bytes);

    expect(second).toEqual(first);
    expect(new TextDecoder().decode(await storage.getBlob(first.id))).toBe("before-image contents");
    expect(await storage.getBlob("missing")).toBeUndefined();
  });

  test("gc removes only unreferenced blobs", async () => {
    const storage = new MemoryStorage();
    const kept = await storage.putBlob(new TextEncoder().encode("kept"));
    const dropped = await storage.putBlob(new TextEncoder().encode("dropped"));

    const removed = await storage.gc([kept.id]);

    expect(removed).toEqual([dropped.id]);
    expect(await storage.getBlob(kept.id)).toBeDefined();
    expect(await storage.getBlob(dropped.id)).toBeUndefined();
  });

  test("referencedBlobs collects before-image addresses from mutations and deletions", () => {
    const other = record({ id: "rec-2", mutated: [], deleted: [{ path: "/home/.other", beforeBlob: "blob-3" }] });
    expect(referencedBlobs([record(), other]).sort()).toEqual(["blob-1", "blob-2", "blob-3"]);
  });
});
