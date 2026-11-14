import { OperationLog, OperationRecoveryRequiredError } from "./operation-log";
import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withOperationLease } from "./operation-lease";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-operation-log-"));
  roots.push(root);
  return root;
}

test("intent, stages and blob pins survive a new lease; unfinished work blocks new mutations", async () => {
  const root = fixture();
  const log = new OperationLog(root);
  expect(log.list()).toEqual([]);
  expect(() => log.begin("install")).toThrow("require the store operation lease");
  let id = "";
  await withOperationLease(root, async () => {
    let operation = log.begin("install");
    id = operation.id;
    operation = log.checkpoint(operation, { pins: ["a".repeat(64)], stage: "running", unknownSince: new Date().toISOString() });
    expect(log.pinnedBlobs()).toEqual(["a".repeat(64)]);
    expect(lstatSync(join(log.directory, `${id}.json`)).mode & 0o777).toBe(0o600);
    expect(() => log.checkpoint(operation, { stage: "prepared" })).toThrow("invalid operation stage");
  });
  await withOperationLease(root, async () => {
    expect(() => log.begin("uninstall")).toThrow(OperationRecoveryRequiredError);
    expect(log.list()[0]?.stage).toBe("running");
    const operation = log.list()[0]!;
    expect(() => log.checkpoint(operation, { stage: "captured" })).toThrow("different lease");
    log.discard(id);
    expect(log.pinnedBlobs()).toEqual([]);
    log.begin("metadata");
  });
});

test("stale checkpoints and completed-operation replay fail without replacing evidence", async () => {
  const root = fixture();
  const log = new OperationLog(root);
  await withOperationLease(root, async () => {
    const original = log.begin("install");
    let next = log.checkpoint(original, { stage: "running" });
    expect(() => log.checkpoint(original, { stage: "partial" })).toThrow("checkpoint changed");
    next = log.checkpoint(next, { stage: "captured" });
    next = log.checkpoint(next, { stage: "completed" });
    const bytes = readFileSync(join(log.directory, `${next.id}.json`));
    expect(() => log.checkpoint(next, { stage: "running" })).toThrow("cannot be resumed");
    expect(readFileSync(join(log.directory, `${next.id}.json`))).toEqual(bytes);
    log.begin("metadata");
  });
});

test("corrupt and future operation files prevent mutation and collection", async () => {
  const root = fixture();
  const log = new OperationLog(root);
  mkdirSync(log.directory);
  const path = join(log.directory, "01234567-0123-0123-0123-012345678901.json");
  writeFileSync(path, '{"version":999}');
  expect(() => log.pinnedBlobs()).toThrow("invalid operation evidence");
  await withOperationLease(root, async () => {
    expect(() => log.begin("install")).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{"version":999}');
  });
});
