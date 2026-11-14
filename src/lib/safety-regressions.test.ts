import { FakeFsInspector, MemoryBaseline, captureBaseline } from "./capture/linux/inspect";
import { applyUninstallPlan as applyPlan, nodeRemovalFileSystem } from "./removal";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { MacosHeuristicCaptureBackend } from "./capture/macos/backend";
import type { RecordV3 } from "../types";
import { VerifiedUninstallPlanner } from "./uninstall-planner";
import { filesystemIdentity } from "./filesystem-identity";
import { join } from "node:path";
import { normalizeJournal } from "./journal/normalize";
import { reconstruct } from "./capture/linux/reconstruct";
import { tmpdir } from "node:os";

// Injected-filesystem regressions retain the earlier parent-creation bookkeeping checks;
// production native identity/race coverage lives in native-action.test.ts.
const applyUninstallPlan = (plan: Parameters<typeof applyPlan>[0], options: Parameters<typeof applyPlan>[1]) =>
  applyPlan(plan, { ...options, fs: nodeRemovalFileSystem });
const hash = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
function record(path: string): RecordV3 {
  return {
    id: "safety",
    name: "fixture",
    source: "install",
    url: "https://example.com/fixture.sh",
    installedAt: new Date(0).toISOString(),
    executable: path,
    scriptSha256: hash("script"),
    capture: { backend: "linux-strace", completeness: "complete", segments: [] },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path, kind: "file", installedHash: hash("same bytes") }],
    mutated: [],
    deleted: [],
  };
}

test("a baseline omission and O_CREAT do not prove a new disposable file", async () => {
  const path = "/scope/excluded/existing";
  const result = await reconstruct({
    traced: { records: [{ op: "open", at: 1, path, created: true, truncated: true }], diagnostics: [], unsupported: [] },
    inspector: new FakeFsInspector([[path, { kind: "file", hash: hash("installed") }]]),
    baseline: new MemoryBaseline(),
    roots: ["/scope"],
    fallbackAt: 0,
  });
  const effects = normalizeJournal({
    journal: { backend: "linux-strace", completeness: "complete", events: result.events },
    backups: { enabled: false, sizeLimitBytes: 100 },
    caseSensitive: true,
  });
  expect(effects.owned).toEqual([]);
  expect(effects.mutated.map((entry) => entry.path)).toEqual([path]);
});

test("rename preserves the destination before-image instead of owning the destination", async () => {
  const from = "/scope/tmp";
  const to = "/scope/config";
  const baseline = new MemoryBaseline();
  baseline.setNode(to, { kind: "file", hash: hash("original"), size: 8, mode: 0o640 });
  const result = await reconstruct({
    traced: { records: [{ op: "rename", at: 1, from, to }], diagnostics: [], unsupported: [] },
    inspector: new FakeFsInspector([[to, { kind: "file", hash: hash("replacement") }]]),
    baseline,
    roots: ["/scope"],
    fallbackAt: 0,
  });
  const effects = normalizeJournal({
    journal: { backend: "linux-strace", completeness: "complete", events: result.events },
    backups: { enabled: true, sizeLimitBytes: 100 },
    availableBeforeImages: new Set([hash("original")]),
    caseSensitive: true,
  });
  expect(effects.owned).toEqual([]);
  expect(effects.mutated).toContainEqual({
    path: to,
    beforeHash: hash("original"),
    installedHash: hash("replacement"),
    beforeBlob: hash("original"),
    mode: 0o640,
  });
});

test("a parent symlink substitution cannot redirect removal of identical bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-parent-safety-"));
  try {
    const parent = join(root, "parent");
    const sentinel = join(root, "sentinel");
    mkdirSync(parent);
    mkdirSync(sentinel);
    writeFileSync(join(parent, "tool"), "same bytes");
    writeFileSync(join(sentinel, "tool"), "same bytes");
    const plan = await new VerifiedUninstallPlanner(undefined, undefined, async () => undefined).plan(record(join(parent, "tool")));
    renameSync(parent, join(root, "original-parent"));
    symlinkSync(sentinel, parent);
    const result = await applyUninstallPlan(plan, { storage: { getBlob: async () => undefined } });
    expect(result.conflicts).toEqual([join(parent, "tool")]);
    expect(readFileSync(join(sentinel, "tool"), "utf8")).toBe("same bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("force never bypasses another record's claim", async () => {
  const target = record("/scope/tool");
  const plan = await new VerifiedUninstallPlanner(() => ({ exists: true, kind: "file", hash: hash("same bytes") })).plan(
    target,
    {
      force: true,
      otherRecords: [target, { ...target, id: "other" }],
    },
  );
  expect(plan.actions).toEqual([{ action: "conflict", path: "/scope/tool", reason: "shared-owner" }]);
});

test("an identical-byte replacement is a different object after planning", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-object-safety-"));
  try {
    const path = join(root, "tool");
    writeFileSync(path, "same bytes");
    const plan = await new VerifiedUninstallPlanner(undefined, undefined, async () => undefined).plan(record(path));
    writeFileSync(join(root, "replacement"), "same bytes");
    renameSync(join(root, "replacement"), path);
    const result = await applyUninstallPlan(plan, { storage: { getBlob: async () => undefined } });
    expect(result.conflicts).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("same bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two deleted siblings restore under parents created by the same plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-restore-siblings-"));
  try {
    const paths = [join(root, "a/b/one"), join(root, "a/b/two")];
    const target = { ...record(paths[0]!), owned: [], deleted: paths.map((path) => ({ path, beforeBlob: hash(path) })) };
    const plan = await new VerifiedUninstallPlanner(undefined, undefined, async () => undefined).plan(target);
    const result = await applyUninstallPlan(plan, {
      storage: {
        getBlob: async (id) => {
          const path = paths.find((path) => hash(path) === id);
          return path === undefined ? undefined : new TextEncoder().encode(path);
        },
      },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.restored).toEqual(paths);
    for (const path of paths) expect(readFileSync(path, "utf8")).toBe(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dangling symlink ancestor is unverifiable, not an absent directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-dangling-parent-"));
  try {
    symlinkSync(join(root, "missing"), join(root, "parent"));
    expect(filesystemIdentity(join(root, "parent", "child"))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoration still rejects substitution of a parent created by an earlier action", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-restore-parent-swap-"));
  try {
    const first = join(root, "parent/one");
    const second = join(root, "parent/two");
    const outside = join(root, "unrelated");
    mkdirSync(outside);
    const target = { ...record(first), owned: [], deleted: [first, second].map((path) => ({ path, beforeBlob: hash(path) })) };
    const plan = await new VerifiedUninstallPlanner(undefined, undefined, async () => undefined).plan(target);
    const result = await applyUninstallPlan(plan, {
      storage: {
        getBlob: async (id) => {
          if (id === hash(second)) {
            renameSync(join(root, "parent"), join(root, "original"));
            symlinkSync(outside, join(root, "parent"));
          }
          return new TextEncoder().encode("before");
        },
      },
    });
    expect(result.restored).toEqual([first]);
    expect(result.conflicts).toEqual([second]);
    expect(existsSync(join(outside, "two"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux backups reject bytes that grew beyond the stat-time limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-growing-backup-"));
  try {
    const path = join(root, "config");
    writeFileSync(path, "a");
    const result = await captureBaseline([root], {
      backups: { enabled: true, sizeLimitBytes: 10 },
      read: async () => new Uint8Array(11),
    });
    expect(result.beforeImages.size).toBe(0);
    expect(result.baseline.kind(path)).toBe("file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const name of ["macos-heuristic", "linux-heuristic"]) {
  test(`${name} never reads sensitive before-images even for an explicit root`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-private-safety-"));
    try {
      const secret = join(root, ".ssh", "id_fixture");
      mkdirSync(join(root, ".ssh"));
      writeFileSync(secret, "synthetic private key");
      const reads: string[] = [];
      const backend = new MacosHeuristicCaptureBackend({
        name,
        read: async (path) => {
          reads.push(path);
          return new Uint8Array(readFileSync(path));
        },
      });
      const session = await backend.start({
        pid: process.pid,
        privilege: "user",
        roots: [join(root, ".ssh")],
        backups: { enabled: true, sizeLimitBytes: 100 },
      });
      const journal = await session.stop();
      expect(reads).not.toContain(secret);
      expect(journal.beforeImages?.size ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
