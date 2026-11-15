import { CaptureBudget, CaptureBudgetError, DEFAULT_CAPTURE_LIMITS, captureLimits } from "./budget";
import { afterEach, expect, test } from "bun:test";
import { hashBoundedContent, readBoundedContent } from "./content";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { FakeCaptureBackend } from "./fake";
import { adoptedEntries } from "../adoption";
import { captureBaseline } from "./linux/inspect";
import { join } from "node:path";
import { parseStraceOutput } from "./linux/strace";
import { runBoundedSession } from "../session";
import { scanScopedRoots } from "./macos/scoped";
import { snapshot } from "../snapshot";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-capture-budget-"));
  roots.push(root);
  return root;
}

test("capture limits are explicit and reject malformed numeric overrides", () => {
  expect(captureLimits({})).toEqual(DEFAULT_CAPTURE_LIMITS);
  expect(captureLimits({ TRET_CAPTURE_MAX_NODES: "3" }).maxNodes).toBe(3);
  for (const raw of ["0", "-1", "NaN", "Infinity", "1.5", "1e9", "9007199254740992"])
    expect(() => captureLimits({ TRET_CAPTURE_MAX_NODES: raw })).toThrow("positive safe integer");
});
test("node and metadata exhaustion stays fatal across retries", () => {
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxNodes: 1 });
  budget.inspect("/first");
  expect(() => budget.inspect("/second")).toThrow(CaptureBudgetError);
  expect(() => budget.beginPhase()).toThrow(CaptureBudgetError);
  expect(budget.used.nodes).toBe(1);
  const metadata = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxMetadataBytes: 256 });
  expect(() => metadata.inspect("/nonempty")).toThrow("metadataBytes");
});
test("installer runtime does not consume an active scan deadline", () => {
  let now = 0;
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxWorkMs: 10 }, () => now);
  budget.beginPhase();
  now = 5;
  budget.pause();
  now = 100_000;
  budget.check();
  budget.beginPhase();
  now += 11;
  expect(() => budget.check()).toThrow("active work milliseconds");
});

test.each(["backup", "hash"])("a fatal %s read deadline propagates instead of becoming a per-file omission", async (kind) => {
  const path = join(fixture(), "file");
  writeFileSync(path, "content");
  let ticks = 0;
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxWorkMs: 10 }, () => (ticks++ < 3 ? 0 : 100));
  const read = kind === "backup" ? readBoundedContent : hashBoundedContent;
  await expect(read(path, { budget })).rejects.toBeInstanceOf(CaptureBudgetError);
  expect(budget.fatalError?.resource).toBe("active work milliseconds");
});

test("a pre-execution budget failure stays a budget refusal through the durable barrier", async () => {
  let now = 0;
  let ran = false;
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxWorkMs: 10 }, () => now);
  await expect(
    runBoundedSession({
      backend: new FakeCaptureBackend(),
      budget,
      pid: 1,
      privilege: "user",
      roots: [],
      beforeRun: async () => {
        now = 20;
      },
      run: async () => {
        ran = true;
      },
    }),
  ).rejects.toBeInstanceOf(CaptureBudgetError);
  expect(ran).toBe(false);
});
test("aggregate backup bytes bound actual reads across files", async () => {
  const root = fixture();
  const first = join(root, "first");
  const second = join(root, "second");
  writeFileSync(first, "12345");
  writeFileSync(second, "67890");
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxBackupBytes: 8 });
  expect(await readBoundedContent(first, { budget })).toEqual(new TextEncoder().encode("12345"));
  expect(await readBoundedContent(second, { budget })).toBeUndefined();
  expect(budget.used.backupBytes).toBe(5);
  expect([...budget.losses].join(" ")).toContain("aggregate backup");
});
test("fingerprints are streamed and share a separate aggregate byte budget", async () => {
  const root = fixture();
  const first = join(root, "first");
  const second = join(root, "second");
  writeFileSync(first, "12345");
  writeFileSync(second, "67890");
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxHashBytes: 8 });
  expect(await hashBoundedContent(first, { budget })).toBe(new Bun.CryptoHasher("sha256").update("12345").digest("hex"));
  expect(await hashBoundedContent(second, { budget })).toBeUndefined();
  expect(budget.used.hashBytes).toBe(5);
  expect(budget.used.backupBytes).toBe(0);
});
test("content reads refuse final symlinks and special nodes without reading their targets", async () => {
  const root = fixture();
  const target = join(root, "target");
  const link = join(root, "link");
  writeFileSync(target, "secret");
  symlinkSync(target, link);
  const budget = new CaptureBudget();
  expect(await readBoundedContent(link, { budget })).toBeUndefined();
  expect(await hashBoundedContent("/dev/null", { budget })).toBeUndefined();
  expect(budget.used.backupBytes + budget.used.hashBytes).toBe(0);
});

test("all recursive inventories refuse excessive depth without leaking directory handles", async () => {
  const root = fixture();
  mkdirSync(join(root, "a/b/c"), { recursive: true });
  const budget = () => new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxDepth: 1 });
  expect(() => scanScopedRoots([root], { budget: budget(), caseSensitive: true })).toThrow("directory depth");
  expect(() => snapshot([root], budget())).toThrow("directory depth");
  expect(() => adoptedEntries([root], budget())).toThrow("directory depth");
  await expect(captureBaseline([root], { budget: budget() })).rejects.toThrow("directory depth");
});

test("malformed audit lines count toward the parser budget and report truncation", () => {
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxAuditLines: 2 });
  const result = parseStraceOutput("garbage\ngarbage\ngarbage\n", { budget });
  expect(budget.used.auditLines).toBe(2);
  expect(result.diagnostics.join(" ")).toContain("auditLines");
  expect(result.records).toEqual([]);
});

test("a regular file with an understated stat size is never fingerprinted as empty", async () => {
  const root = fixture();
  const source = join(root, "probe.ts");
  writeFileSync(
    source,
    `
    import * as fs from "node:fs";
    import { mock } from "bun:test";
    const real = { ...fs };
    const path = process.argv[2] + "/pseudo-file";
    real.writeFileSync(path, "not empty");
    let selected;
    mock.module("node:fs", () => ({ ...real,
      openSync: (...args) => { const fd = real.openSync(...args); if (args[0] === path) selected = fd; return fd; },
      fstatSync: (...args) => { const stat = real.fstatSync(...args); return args[0] === selected ? { ...stat, size: 0n, isFile: () => true } : stat; },
    }));
    const { hashBoundedContent, readBoundedContent } = await import(${JSON.stringify(join(import.meta.dir, "content.ts"))});
    if (await hashBoundedContent(path) !== undefined || await readBoundedContent(path) !== undefined)
      throw new Error("understated content was accepted");
  `,
  );
  const child = Bun.spawn([process.execPath, source, root], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});
