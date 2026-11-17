import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-find-budget-"));
  homes.push(home);
  const bin = join(home, "bin"),
    name = "tret-find-budget-fixture",
    executable = join(bin, name);
  mkdirSync(bin);
  writeFileSync(executable, '#!/bin/sh\ntouch "$HOME/EXECUTED"\n', { mode: 0o755 });
  for (let i = 0; i < 40; i++) writeFileSync(join(home, `unrelated-${i}`), "unrelated");
  const storage = new FileStorage({ homeDir: home });
  await storage.saveRecord({
    id: "keep",
    name: "keep",
    source: "find",
    url: "",
    installedAt: "2026-11-16",
    executable,
    scriptSha256: "",
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    capture: { backend: "find", completeness: "heuristic", segments: [{ kind: "find", startedAt: "2026-11-16" }] },
  });
  return { home, bin, name, executable, storage };
}
async function run(home: string, bin: string, name: string, overrides: Record<string, string>) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../index.ts"), "find", name], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...overrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

test("find budget refusal preserves existing records and never executes the command", async () => {
  const { home, bin, name, storage } = await fixture();
  const path = join(home, ".tret/records.json"),
    before = readFileSync(path);
  const result = await run(home, bin, name, { TRET_CAPTURE_MAX_NODES: "12" });
  expect(result.code).toBe(5);
  expect(result.err).toContain("capture budget exhausted: nodes");
  expect(readFileSync(path)).toEqual(before);
  expect(await storage.loadRecords()).toHaveLength(1);
  expect(existsSync(join(home, "EXECUTED"))).toBe(false);
});

test("find persists discovery/inventory limits and hash omissions without granting cleanup approval", async () => {
  const { home, bin, name, executable, storage } = await fixture();
  const result = await run(home, bin, name, { TRET_CAPTURE_MAX_HASH_BYTES: "1" });
  expect(result.code).toBe(0);
  const record = (await storage.loadRecords()).find((entry) => entry.name === name)!;
  const segment = record.capture.segments[0]!;
  expect(segment.resources?.used.nodes).toBeGreaterThan(40);
  expect(segment.resources?.losses.some((reason) => reason.includes("fingerprint byte budget"))).toBe(true);
  expect(segment.roots).toContain(home);
  expect(segment.roots).toContain(executable);
  expect(record.owned.find((entry) => entry.path === executable)?.installedHash).toBeUndefined();
  expect(record.evidence.every((entry) => entry.authority === "none")).toBe(true);
  expect(existsSync(join(home, "EXECUTED"))).toBe(false);
});

test("invalid discovery limits refuse with usage status and preserve the store", async () => {
  const { home, bin, name } = await fixture();
  const path = join(home, ".tret/records.json"),
    before = readFileSync(path);
  const result = await run(home, bin, name, { TRET_CAPTURE_MAX_NODES: "invalid" });
  expect(result.code).toBe(2);
  expect(result.err).toContain("positive safe integer");
  expect(readFileSync(path)).toEqual(before);
});
