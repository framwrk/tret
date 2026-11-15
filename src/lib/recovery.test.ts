import { FileStorage, RecordRevisionError } from "./store";
import { VerifiedUninstallPlanner, inspectPath } from "./uninstall-planner";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { cleanupSnapshot } from "./cleanup-authority";
import { join } from "node:path";
import { resumeOperation } from "./recovery";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-recovery-"));
  homes.push(home);
  const storage = new FileStorage({ homeDir: home });
  const executable = join(home, "must-not-run");
  const sentinel = join(home, "executed");
  writeFileSync(executable, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
  const record: RecordV3 = {
    id: "fixture",
    name: "fixture",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-11-11",
    executable,
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    capture: { backend: "pending", completeness: "partial", segments: [{ kind: "install", startedAt: "2026-11-11" }] },
  };
  return { home, storage, record, sentinel };
}

test("a running checkpoint blocks mutations, recovers as partial and never executes its program", async () => {
  const { storage, record, sentinel } = fixture();
  let id = "";
  await storage.withOperation(async () => {
    const operation = storage.operations.begin("install");
    id = operation.id;
    storage.operations.checkpoint(operation, { checkpoint: record, stage: "running", unknownSince: new Date().toISOString() });
  });
  await expect(storage.saveRecord({ ...record, id: "another" })).rejects.toThrow("explicit recovery");
  expect((await resumeOperation(storage, id)).stage).toBe("partial");
  expect(existsSync(sentinel)).toBe(false);
  expect((await storage.loadRecords())[0]?.capture.completeness).toBe("partial");
  await expect(resumeOperation(storage, id)).rejects.toThrow("terminal receipt");
  expect(existsSync(sentinel)).toBe(false);
});

test("closed capture evidence is normalized if interruption preceded the final record build", async () => {
  const { home, storage, record, sentinel } = fixture();
  const path = join(home, "candidate");
  writeFileSync(path, "observed");
  const hash = new Bun.CryptoHasher("sha256").update("observed").digest("hex");
  let id = "";
  await storage.withOperation(async () => {
    let operation = storage.operations.begin("install");
    id = operation.id;
    operation = storage.operations.checkpoint(operation, { checkpoint: record, stage: "running" });
    storage.operations.checkpoint(operation, {
      stage: "captured",
      capture: {
        backend: "heuristic",
        completeness: "heuristic",
        events: [{ type: "create", path, seq: 0, at: 1, after: { kind: "file", hash, size: 8 } }],
      },
    });
  });
  await resumeOperation(storage, id);
  const recovered = (await storage.loadRecords())[0]!;
  expect(recovered.owned[0]?.path).toBe(path);
  expect(recovered.evidence[0]?.authority).toBe("none");
  expect(existsSync(sentinel)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("observed");
});

test("recovery retains normalization explanations in the recovered segment and receipt without execution", async () => {
  const { home, storage, record, sentinel } = fixture();
  const path = join(home, "temporary");
  let id = "";
  await storage.withOperation(async () => {
    let operation = storage.operations.begin("install");
    id = operation.id;
    operation = storage.operations.checkpoint(operation, { checkpoint: record, stage: "running" });
    storage.operations.checkpoint(operation, {
      stage: "captured",
      capture: {
        backend: "fixture",
        completeness: "complete",
        events: [
          { type: "create", path, seq: 0, at: 1, after: { kind: "file" } },
          { type: "unlink", path, seq: 1, at: 2, before: { kind: "file" } },
        ],
      },
    });
  });
  const operation = await resumeOperation(storage, id);
  const recovered = (await storage.loadRecords())[0]!;
  expect(recovered.capture.segments.at(-1)!.normalization).toEqual({
    entries: [{ code: "create-delete", message: "a path was created and then removed by the install", paths: [path] }],
    omitted: 0,
  });
  expect(operation.capture!.normalization).toEqual(recovered.capture.segments.at(-1)!.normalization);
  expect(operation.checkpoint!.capture.segments.at(-1)!.normalization).toEqual(operation.capture!.normalization);
  expect(recovered.capture.completeness).toBe("partial");
  expect(recovered.evidence).toEqual([]);
  expect(existsSync(sentinel)).toBe(false);
});

test("operation reads refuse malformed normalization metadata without changing its bytes", async () => {
  const { storage } = fixture();
  let id = "";
  await storage.withOperation(async () => {
    id = storage.operations.begin("install").id;
  });
  const file = join(storage.operations.directory, `${id}.json`);
  const operation = JSON.parse(readFileSync(file, "utf8"));
  expect(operation.version).toBe(2);
  operation.inline.capture = {
    backend: "fixture",
    completeness: "complete",
    events: [],
    normalization: { entries: [], omitted: -1 },
  };
  operation.bytes = Buffer.byteLength(JSON.stringify(operation.inline));
  writeFileSync(file, JSON.stringify(operation));
  const before = readFileSync(file);
  expect(() => storage.operations.get(id)).toThrow();
  expect(readFileSync(file)).toEqual(before);
});

test("interrupted trace normalization appends its own partial segment without changing the install window", async () => {
  const { home, storage, record, sentinel } = fixture();
  const originalPath = join(home, "original-data");
  writeFileSync(originalPath, "original");
  const installed = await storage.saveRecord({
    ...record,
    owned: [
      { path: originalPath, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update("original").digest("hex") },
    ],
    capture: { ...record.capture, backend: "snapshot-install", completeness: "complete" },
  });
  await storage.saveRecord({
    ...installed,
    evidence: installed.evidence.map((entry) => ({
      ...entry,
      authority: "user-approved" as const,
      approval: { action: "remove" as const, approvedAt: new Date().toISOString(), current: cleanupSnapshot(originalPath) },
    })),
  });
  const prior = (await storage.loadRecords())[0]!;
  const original = JSON.stringify(prior.capture.segments[0]);
  const path = join(home, "temporary");
  const observed = join(home, "observed");
  writeFileSync(observed, "observed");
  let id = "";
  await storage.withOperation(async () => {
    let operation = storage.operations.begin("trace", [prior]);
    id = operation.id;
    operation = storage.operations.checkpoint(operation, { checkpoint: prior, stage: "running" });
    storage.operations.checkpoint(operation, {
      capture: {
        backend: "strace-trace",
        completeness: "partial",
        partialReason: "durable prefix",
        events: [
          { type: "create", path, seq: 0, at: 1, after: { kind: "file" } },
          { type: "unlink", path, seq: 1, at: 2, before: { kind: "file" } },
          { type: "create", path: observed, seq: 2, at: 3, after: { kind: "file" } },
        ],
      },
    });
  });
  const receipt = await resumeOperation(storage, id);
  const recovered = (await storage.loadRecords())[0]!;
  expect(recovered.capture.segments).toHaveLength(2);
  expect(recovered.capture.backend).toBe("snapshot-install");
  expect(recovered.evidence?.find((entry) => entry.path === observed)).toMatchObject({ origin: "trace", authority: "none" });
  expect(recovered.evidence?.find((entry) => entry.path === originalPath)).toMatchObject({
    origin: "capture",
    authority: "none",
  });
  expect("approval" in recovered.evidence!.find((entry) => entry.path === originalPath)!).toBe(false);
  expect(JSON.stringify(recovered.capture.segments[0])).toBe(original);
  expect(recovered.capture.segments[1]).toMatchObject({ kind: "trace", partialReason: expect.stringContaining("interrupted") });
  expect(recovered.capture.segments[1]!.normalization?.entries.map((entry) => entry.code)).toEqual([
    "coverage",
    "create-delete",
  ]);
  expect(receipt.capture!.normalization).toEqual(recovered.capture.segments[1]!.normalization);
  expect(existsSync(sentinel)).toBe(false);
});

test.each(["owned", "mutated", "deleted"] as const)(
  "interrupted trace leaves another record's %s path claim unchanged",
  async (section) => {
    const { home, storage, record, sentinel } = fixture();
    const path = join(home, "shared-bin");
    writeFileSync(path, "other owner");
    const other = await storage.saveRecord({
      ...record,
      id: "other",
      name: "other",
      executable: path,
      capture: { ...record.capture, backend: "fixture" },
      owned: [{ path, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update("other owner").digest("hex") }],
    });
    const owner = await storage.saveRecord({
      ...other,
      evidence: other.evidence.map((entry) => ({
        ...entry,
        authority: "user-approved" as const,
        approval: { action: "remove" as const, approvedAt: new Date().toISOString(), current: cleanupSnapshot(path) },
      })),
    });
    const prior = await storage.saveRecord({ ...record, capture: { ...record.capture, backend: "snapshot-install" } });
    const planner = new VerifiedUninstallPlanner(inspectPath);
    const before = await planner.plan(owner, { otherRecords: await storage.loadRecords() });
    expect(before.incomplete).toBe(false);
    let id = "";
    await storage.withOperation(async () => {
      let operation = storage.operations.begin("trace", [prior]);
      id = operation.id;
      operation = storage.operations.checkpoint(operation, { checkpoint: prior, stage: "running" });
      storage.operations.checkpoint(operation, {
        capture: {
          backend: "strace-trace",
          completeness: "complete",
          events: [
            section === "owned"
              ? { type: "create", path, seq: 0, at: 1, after: { kind: "file" } }
              : section === "mutated"
                ? { type: "write", path, seq: 0, at: 1, after: { kind: "file" } }
                : { type: "unlink", path, seq: 0, at: 1, before: { kind: "file" } },
          ],
        },
      });
    });
    const receipt = await resumeOperation(storage, id);
    const records = await storage.loadRecords();
    const recovered = records.find((entry) => entry.id === prior.id)!;
    expect(recovered[section]).toEqual([]);
    expect(records.find((entry) => entry.id === owner.id)).toEqual(owner);
    expect(await planner.plan(owner, { otherRecords: records })).toEqual(before);
    expect(receipt.capture!.events).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("other owner");
    expect(existsSync(sentinel)).toBe(false);
  },
);

test.each([true, false])(
  "replacement recovery without an application checkpoint preserves prior claims (present: %s)",
  async (present) => {
    const { storage, record, sentinel } = fixture();
    record.owned = [
      {
        path: record.executable,
        kind: "file",
        installedHash: new Bun.CryptoHasher("sha256").update(readFileSync(record.executable)).digest("hex"),
      },
    ];
    const prior = await storage.saveRecord(record);
    if (!present) await storage.removeRecord(prior.id, prior.revision);
    let id = "";
    await storage.withOperation(async () => {
      const operation = storage.operations.begin("replace", [prior]);
      id = operation.id;
      storage.operations.checkpoint(operation, {
        stage: "applying",
        checkpoint: { ...record, executable: "", owned: [] },
      });
    });
    const before = readFileSync(storage.recordsPath);
    await expect(resumeOperation(storage, id)).rejects.toBeInstanceOf(RecordRevisionError);
    expect(readFileSync(storage.recordsPath)).toEqual(before);
    expect(storage.operations.list()[0]?.priorRecords[0]).toEqual(prior);
    expect(storage.operations.list()[0]?.stage).toBe("applying");
    expect(existsSync(record.executable)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  },
);
