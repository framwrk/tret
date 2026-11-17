import { afterEach, expect, test } from "bun:test";
import { buildInspectReport, formatInspect } from "./inspect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FakeCaptureBackend } from "../lib/capture/fake";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { operationSummary } from "../lib/operation-log";
import { resumeOperation } from "../lib/recovery";
import { tmpdir } from "node:os";
import { trace } from "./trace";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test.each(["normal", "recovered"])(
  "%s trace retains skipped window facts without replacing installation evidence",
  async (phase) => {
    const home = mkdtempSync(join(tmpdir(), "tret-trace-observations-"));
    homes.push(home);
    const scope = join(home, "scope");
    mkdirSync(scope);
    const owned = join(scope, "owned"),
      mutated = join(scope, "mutated"),
      deleted = join(scope, "deleted"),
      shared = join(scope, "shared"),
      fresh = join(scope, "document"),
      sentinel = join(home, "REPLAYED");
    const program = join(home, "must-not-run");
    writeFileSync(program, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    const storage = new FileStorage({ homeDir: home });
    const blob = await storage.putBlob(new TextEncoder().encode("original"));
    const record: RecordV3 = {
      id: "fixture",
      name: "fixture",
      source: "install",
      url: "https://example.com/install.sh",
      installedAt: "2026-11-16",
      executable: owned,
      scriptSha256: hash("script"),
      privilege: "user",
      caseSensitive: true,
      owned: [{ path: owned, kind: "file", installedHash: hash("installed") }],
      mutated: [{ path: mutated, beforeHash: blob.id, beforeBlob: blob.id, installedHash: hash("installed"), mode: 0o640 }],
      deleted: [{ path: deleted, beforeHash: blob.id, beforeBlob: blob.id, mode: 0o600 }],
      capture: {
        backend: "install-backend",
        completeness: "partial",
        segments: [{ kind: "install", startedAt: "2026-11-16" }],
      },
    };
    const prior = await storage.saveRecord(record);
    const other = await storage.saveRecord({
      ...record,
      id: "other",
      name: "other",
      executable: shared,
      owned: [{ path: shared, kind: "file", installedHash: hash("shared") }],
      mutated: [],
      deleted: [],
    });
    const backend = new FakeCaptureBackend();
    for (const path of [owned, mutated])
      backend.push({
        type: "write",
        path,
        before: { kind: "file", hash: hash("installed"), size: 9 },
        after: { kind: "file", hash: hash("runtime"), size: 7 },
      });
    for (const path of [deleted, shared, fresh])
      backend.push({ type: "create", path, after: { kind: "file", hash: hash("runtime"), size: 7 } });
    const update = () => {
      for (const path of [owned, mutated, deleted, shared, fresh]) writeFileSync(path, "runtime");
    };
    if (phase === "normal")
      await trace("fixture", true, {
        storage,
        backend,
        roots: [scope],
        run: async () => {
          update();
          return 0;
        },
      });
    else {
      update();
      await storage.withOperation(async () => {
        let op = storage.operations.begin("trace", [prior]);
        op = storage.operations.checkpoint(op, {
          stage: "running",
          checkpoint: prior,
          execution: { recordId: prior.id, roots: [scope], executable: program },
        });
        const session = await backend.start({ pid: process.pid, privilege: "user", roots: [scope] });
        storage.operations.checkpoint(op, { stage: "captured", capture: await session.stop() });
      });
      const pending = storage.operations.list().find((op) => op.kind === "trace")!;
      await resumeOperation(storage, pending.id);
    }
    const records = await storage.loadRecords(),
      saved = records.find((entry) => entry.id === prior.id)!;
    expect(saved.owned.filter((entry) => entry.path !== fresh)).toEqual(prior.owned);
    expect(saved.mutated).toEqual(prior.mutated);
    expect(saved.deleted).toEqual(prior.deleted);
    expect(records.find((entry) => entry.id === other.id)).toEqual(other);
    const segment = saved.capture.segments.at(-1)!;
    expect(segment.observations).toEqual({
      omitted: 0,
      entries: [
        ...[deleted].map((path) => ({
          effect: "created" as const,
          path,
          kind: "file" as const,
          installedHash: hash("runtime"),
          disposition: "already-tracked" as const,
        })),
        { effect: "created", path: fresh, kind: "file", installedHash: hash("runtime"), disposition: "new-candidate" },
        { effect: "created", path: shared, kind: "file", installedHash: hash("runtime"), disposition: "claimed-by-other" },
        ...[mutated, owned].map((path) => ({
          effect: "modified" as const,
          path,
          beforeHash: hash("installed"),
          installedHash: hash("runtime"),
          disposition: "already-tracked" as const,
        })),
      ],
    });
    expect(saved.capture.segments[0]).toEqual(prior.capture.segments[0]);
    expect(saved.evidence.filter((entry) => entry.path === fresh).every((entry) => entry.authority === "none")).toBe(true);
    expect(new TextDecoder().decode(await storage.getBlob(blob.id))).toBe("original");
    const operation = storage.operations.list().find((op) => op.kind === "trace")!;
    expect(operationSummary(operation).capture?.observations).toEqual(segment.observations);
    const before = readFileSync(join(home, ".tret/records.json"));
    const report = await buildInspectReport(saved, records, { home, getBlob: (id) => storage.getBlob(id) });
    expect(formatInspect(report).join("\n")).toContain(`observed modified ${mutated} (already-tracked`);
    expect(readFileSync(join(home, ".tret/records.json"))).toEqual(before);
    expect(readFileSync(owned, "utf8")).toBe("runtime");
    expect(existsSync(sentinel)).toBe(false);
    const recordsPath = join(home, ".tret/records.json"),
      raw = JSON.parse(before.toString());
    raw.records.find((entry: RecordV3) => entry.id === saved.id).capture.segments.at(-1).observations.omitted = -1;
    const malformed = JSON.stringify(raw);
    writeFileSync(recordsPath, malformed);
    try {
      await expect(storage.loadRecords()).rejects.toThrow();
      expect(readFileSync(recordsPath, "utf8")).toBe(malformed);
    } finally {
      writeFileSync(recordsPath, before);
    }
    const receiptPath = join(storage.operations.directory, `${operation.id}.json`),
      receipt = readFileSync(receiptPath);
    const envelope = JSON.parse(receipt.toString());
    envelope.inline.capture.observations.entries[0].disposition = "approved";
    envelope.bytes = Buffer.byteLength(JSON.stringify(envelope.inline));
    writeFileSync(receiptPath, JSON.stringify(envelope));
    try {
      expect(() => storage.operations.get(operation.id)).toThrow("invalid operation evidence");
    } finally {
      writeFileSync(receiptPath, receipt);
    }
  },
);
