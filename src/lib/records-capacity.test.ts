import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_PRIVATE_READ_BYTES } from "./atomic";
import { FileStorage } from "./store";
import type { RecordV3 } from "../types";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-record-capacity-"));
  homes.push(home);
  return { home, storage: new FileStorage({ homeDir: home }) };
}
function record(id: string, reason = "fixture"): RecordV3 {
  return {
    id,
    name: id,
    source: "install",
    url: "https://example.com",
    executable: "/fixture/tool",
    installedAt: "2026-11-15",
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    capture: {
      backend: "fixture",
      completeness: "partial",
      segments: [{ kind: "install", startedAt: "2026-11-15", partialReason: reason }],
    },
    owned: [],
    mutated: [],
    deleted: [],
  };
}
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

test("a UTF-8 record save cannot exceed the reader ceiling or poison existing records; freeing metadata allows retry", async () => {
  const { storage } = fixture();
  const reason = "é".repeat(DEFAULT_PRIVATE_READ_BYTES / 4);
  const first = await storage.saveRecord(record("first", reason));
  const before = hash(readFileSync(storage.recordsPath));
  await expect(storage.saveRecord(record("second", reason))).rejects.toThrow("records file limit");
  expect(hash(readFileSync(storage.recordsPath))).toBe(before);
  expect((await storage.loadRecords()).map((entry) => entry.id)).toEqual(["first"]);
  expect(existsSync(storage.recordsPath + ".lock")).toBe(false);
  await storage.removeRecord(first.id, first.revision);
  await storage.saveRecord(record("second", reason));
  expect((await storage.loadRecords()).map((entry) => entry.id)).toEqual(["second"]);
}, 30_000);

test("oversized migration expansion refuses before publishing or retaining a needless backup", async () => {
  const { storage } = fixture();
  await storage.prepareCurrentFormat();
  const base = JSON.stringify({ version: 3, records: [record("legacy", "")] });
  const raw = JSON.stringify({
    version: 3,
    records: [record("legacy", "x".repeat(DEFAULT_PRIVATE_READ_BYTES - Buffer.byteLength(base)))],
  });
  expect(Buffer.byteLength(raw)).toBe(DEFAULT_PRIVATE_READ_BYTES);
  writeFileSync(storage.recordsPath, raw);
  const before = hash(readFileSync(storage.recordsPath));
  await expect(storage.prepareCurrentFormat()).rejects.toThrow("records file limit");
  expect(existsSync(storage.recordsPath + ".lock")).toBe(false);
  expect(hash(readFileSync(storage.recordsPath))).toBe(before);
  expect(readdirSync(dirname(storage.recordsPath)).some((name) => name.includes("legacy-v3"))).toBe(false);
}, 30_000);

test.each(["prepared", "running", "applying", "partial", "recover"] as const)(
  "capacity refusal is structured for durable stage %s",
  async (phase) => {
    const { home, storage } = fixture();
    const probe = join(home, "probe.ts");
    writeFileSync(
      probe,
      `
    import { FileStorage } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
    import { DEFAULT_PRIVATE_READ_BYTES } from ${JSON.stringify(join(import.meta.dir, "atomic.ts"))};
    import { runStoreOperation } from ${JSON.stringify(join(import.meta.dir, "command-operation.ts"))};
    import { recover } from ${JSON.stringify(join(import.meta.dir, "../commands/recover.ts"))};
    import { enableJsonMode } from ${JSON.stringify(join(import.meta.dir, "json-output.ts"))};
    import { writeFileSync } from 'node:fs';
    enableJsonMode();
    const record = ${record.toString()};
    const storage = new FileStorage();
    const reason = 'é'.repeat(DEFAULT_PRIVATE_READ_BYTES / 4);
    await storage.saveRecord(record('first', reason));
    let id;
    const work = async () => {
      let operation = storage.operations.begin('install'); id = operation.id;
      ${phase === "recover" ? "operation = storage.operations.checkpoint(operation, {stage:'running'});" : ""}
      storage.operations.checkpoint(operation, { stage: ${JSON.stringify(phase === "recover" ? "captured" : phase)},
        checkpoint: record('second', ${phase === "recover" ? "reason" : "'fixture'"}) });
      ${phase !== "prepared" ? `writeFileSync(${JSON.stringify(join(home, "work-started"))}, 'started');` : ""}
      ${phase !== "recover" ? "await storage.saveRecord(record('second', reason));" : ""}
    };
    ${phase === "recover" ? "await storage.withOperation(work); await recover(id, 'resume', true);" : "await runStoreOperation(storage, work);"}
  `,
    );
    const child = Bun.spawn([process.execPath, probe], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (!out.trim()) throw new Error(`fixture exited ${code} without JSON: ${err}`);
    expect({ code, json: JSON.parse(out), err }).toMatchObject({
      code: phase === "prepared" ? 5 : 1,
      json: { ok: false, error: { code: phase === "prepared" ? "records-capacity" : "records-capacity-partial" } },
    });
    expect((await storage.loadRecords()).map((entry) => entry.id)).toEqual(["first"]);
    expect(storage.operations.list()[0]?.stage).toBe(phase === "recover" ? "captured" : phase);
    expect(existsSync(join(home, "work-started"))).toBe(phase !== "prepared");
    expect(existsSync(storage.recordsPath + ".lock")).toBe(false);
  },
  30_000,
);
