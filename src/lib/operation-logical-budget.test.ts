import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { DurableOperation } from "./operation-log";
import { OperationLog } from "./operation-log";
import { RecoveryRetentionError } from "./recovery-retention";
import { join } from "node:path";
import { operationText } from "./operation-chunks";
import { tmpdir } from "node:os";
import { withOperationLease } from "./operation-lease";

const MiB = 1024 * 1024;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(maxBytes = 64 * MiB) {
  const home = mkdtempSync(join(tmpdir(), "tret-logical-budget-"));
  homes.push(home);
  return new OperationLog(home, { maxBytes, maxEntries: 1024, maxWorkMs: 30_000 });
}
function lowered(log: OperationLog) {
  return new OperationLog(log.stateDir, { maxBytes: 6 * MiB, maxEntries: 1024, maxWorkMs: 30_000 });
}
async function completed(log: OperationLog, bytes: number): Promise<DurableOperation> {
  return withOperationLease(log.stateDir, async () =>
    log.checkpoint(log.begin("metadata"), {
      stage: "completed",
      reason: "x".repeat(bytes),
    }),
  );
}

test("logical listing refuses before decoding the over-budget receipt even when chunks fit the physical quota", async () => {
  const log = fixture();
  const ops = [await completed(log, 4 * MiB), await completed(log, 4 * MiB)].sort((a, b) => a.id.localeCompare(b.id));
  const small = lowered(log);
  expect(small.retention.inventory().reduce((n, entry) => n + entry.size, 0)).toBeLessThan(6 * MiB);
  expect(small.get(ops[1]!.id)?.reason).toHaveLength(4 * MiB);
  const root = JSON.parse(readFileSync(join(log.directory, `${ops[1]!.id}.json`), "utf8"));
  const part = join(log.directory, `${ops[1]!.id}.${root.parts[0].hash}.part`);
  const bytes = readFileSync(part);
  unlinkSync(part);
  try {
    expect(() => small.list()).toThrow(RecoveryRetentionError);
    expect(() => small.list()).toThrow("logical");
    expect(() => small.list()).toThrow(ops[1]!.id);
  } finally {
    writeFileSync(part, bytes, { mode: 0o600 });
  }
});

test("exact inspection and discard reconcile a legacy logical excess without losing another receipt", async () => {
  const log = fixture();
  const first = await completed(log, 4 * MiB),
    second = await completed(log, 4 * MiB);
  const small = lowered(log);
  expect(() => small.list()).toThrow("logical");
  const before = readFileSync(join(log.directory, `${second.id}.json`));
  await withOperationLease(log.stateDir, async () => {
    small.discard(first.id);
  });
  expect(readFileSync(join(log.directory, `${second.id}.json`))).toEqual(before);
  expect(small.get(second.id)).toEqual(second);
  expect(small.list()).toHaveLength(2);
  await withOperationLease(log.stateDir, async () => {
    small.discard(second.id);
    expect(small.begin("metadata").stage).toBe("prepared");
  });
});

test("new intents reserve logical checkpoint headroom independently of physical bytes", async () => {
  const log = fixture();
  await completed(log, 4 * MiB);
  const small = lowered(log);
  expect(small.retention.inventory().reduce((n, entry) => n + entry.size, 0) + 3 * MiB).toBeLessThan(6 * MiB);
  const before = readdirSync(log.directory).sort();
  await withOperationLease(log.stateDir, async () => {
    expect(() => small.begin("install")).toThrow("logical");
  });
  expect(readdirSync(log.directory).sort()).toEqual(before);
});

test("logical checkpoint refusal keeps the old root and writes no unpublished chunks", async () => {
  const log = fixture(6 * MiB);
  await completed(log, 2 * MiB);
  await withOperationLease(log.stateDir, async () => {
    const operation = log.begin("install");
    const path = join(log.directory, `${operation.id}.json`);
    const before = readFileSync(path),
      names = readdirSync(log.directory).sort();
    expect(() => log.checkpoint(operation, { stage: "running", reason: "y".repeat(4 * MiB) })).toThrow("logical");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(log.directory).sort()).toEqual(names);
    expect(log.get(operation.id)).toEqual(operation);
  });
});

test("the exact logical boundary is readable and a one-byte expansion preserves the last root", async () => {
  const log = fixture(6 * MiB);
  await withOperationLease(log.stateDir, async () => {
    const initial = log.begin("install");
    const overhead = Buffer.byteLength(operationText({ ...initial, stage: "running", reason: "" }));
    const reason = "x".repeat(6 * MiB - overhead);
    const operation = log.checkpoint(initial, { stage: "running", reason });
    expect(Buffer.byteLength(operationText(operation))).toBe(6 * MiB);
    expect(log.list()[0]?.reason).toBe(reason);
    const before = readFileSync(join(log.directory, `${operation.id}.json`));
    expect(() => log.checkpoint(operation, { reason: reason + "x" })).toThrow("logical");
    expect(readFileSync(join(log.directory, `${operation.id}.json`))).toEqual(before);
  });
});

test("legacy v1 bytes participate in the logical budget without migration", async () => {
  const log = fixture();
  const legacy = { ...await completed(log, 2 * MiB), version: 1 as const };
  await completed(log, 4 * MiB);
  const path = join(log.directory, `${legacy.id}.json`);
  writeFileSync(path, JSON.stringify(legacy));
  for (const name of readdirSync(log.directory))
    if (name.startsWith(legacy.id + ".") && name.endsWith(".part")) unlinkSync(join(log.directory, name));
  const before = readFileSync(path),
    small = lowered(log);
  expect(small.retention.inventory().reduce((n, entry) => n + entry.size, 0)).toBeLessThan(6 * MiB);
  expect(small.get(legacy.id)).toEqual(legacy);
  expect(() => small.list()).toThrow("logical");
  expect(readFileSync(path)).toEqual(before);
});
