import { FileStorage, RecordRevisionError } from "./store";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
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
