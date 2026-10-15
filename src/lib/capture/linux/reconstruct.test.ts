import { FakeFsInspector, MemoryBaseline, RealFsInspector } from "./inspect";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import type { BackupPolicy } from "../normalize";
import type { ReconstructInput } from "./reconstruct";
import type { TracerRecord } from "./raw";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { reconstruct } from "./reconstruct";
import { tmpdir } from "node:os";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const ROOTS = ["/h"];

const NO_BACKUPS: BackupPolicy = { enabled: false, sizeLimitBytes: 1024 };

async function run(records: TracerRecord[], options: Partial<Pick<ReconstructInput, "inspector" | "baseline">> = {}) {
  const result = await reconstruct({
    traced: { records, unsupported: [], diagnostics: [] },
    inspector: options.inspector ?? new FakeFsInspector(),
    baseline: options.baseline ?? new MemoryBaseline(),
    roots: ROOTS,
    fallbackAt: 1000,
  });
  const effects = normalizeJournal({
    journal: { backend: "linux-strace", completeness: "complete", events: result.events },
    backups: NO_BACKUPS,
    caseSensitive: true,
  });
  return { result, effects };
}

function file(hash: string) {
  return { kind: "file" as const, hash, size: 4 };
}

describe("linux reconstruction: created paths", () => {
  test("create, write, chmod and symlink become owned entries with the installed hash", async () => {
    const inspector = new FakeFsInspector([
      ["/h/.mytool/bin/tool", file(HASH_A)],
      ["/h/.local/bin/tool", { kind: "symlink", target: "/h/.mytool/bin/tool" }],
    ]);
    const { effects } = await run(
      [
        { op: "mkdir", at: 1, pid: 9, path: "/h/.mytool" },
        { op: "mkdir", at: 2, pid: 9, path: "/h/.mytool/bin" },
        { op: "open", at: 3, pid: 9, path: "/h/.mytool/bin/tool", created: true, truncated: true, mode: 0o755 },
        { op: "write", at: 4, pid: 9, path: "/h/.mytool/bin/tool" },
        { op: "chmod", at: 5, pid: 9, path: "/h/.mytool/bin/tool", mode: 0o755 },
        { op: "symlink", at: 6, pid: 9, path: "/h/.local/bin/tool", target: "/h/.mytool/bin/tool" },
      ],
      { inspector },
    );

    expect(effects.owned).toContainEqual({ path: "/h/.mytool", kind: "directory" });
    expect(effects.owned).toContainEqual({ path: "/h/.mytool/bin", kind: "directory" });
    expect(effects.owned).toContainEqual({ path: "/h/.mytool/bin/tool", kind: "file", installedHash: HASH_A });
    expect(effects.owned).toContainEqual({ path: "/h/.local/bin/tool", kind: "symlink", linkTarget: "/h/.mytool/bin/tool" });
    expect(effects.mutated).toEqual([]);
    expect(effects.deleted).toEqual([]);
  });

  test("a temp file written and renamed over its destination collapses to the destination", async () => {
    const inspector = new FakeFsInspector([["/h/bin/tool", file(HASH_A)]]);
    const { result, effects } = await run(
      [
        { op: "open", at: 1, pid: 9, path: "/h/.tmp.tool", created: true, truncated: true },
        { op: "write", at: 2, pid: 9, path: "/h/.tmp.tool" },
        { op: "rename", at: 3, pid: 9, from: "/h/.tmp.tool", to: "/h/bin/tool" },
      ],
      { inspector },
    );

    expect(effects.owned).toEqual([{ path: "/h/bin/tool", kind: "file", installedHash: HASH_A }]);
    expect(effects.mutated).toEqual([]);
    const diagnostics = normalizeJournal({
      journal: { backend: "linux-strace", completeness: "complete", events: result.events },
      backups: NO_BACKUPS,
      caseSensitive: true,
    }).diagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "temp-rename")).toBe(true);
  });

  test("a created path that is then removed cancels out with a create-delete diagnostic", async () => {
    const { effects } = await run([
      { op: "open", at: 1, pid: 9, path: "/h/scratch", created: true, truncated: true },
      { op: "unlink", at: 2, pid: 9, path: "/h/scratch" },
    ]);

    expect(effects.owned).toEqual([]);
    expect(effects.deleted).toEqual([]);
    expect(effects.diagnostics.some((diagnostic) => diagnostic.code === "create-delete")).toBe(true);
  });
});

describe("linux reconstruction: pre-existing paths", () => {
  test("an overwrite is a non-restorable mutation when no before-image exists", async () => {
    const inspector = new FakeFsInspector([["/h/.mytool/config", file(HASH_B)]]);
    const baseline = new MemoryBaseline([["/h/.mytool/config", "file"]]);
    const { effects } = await run(
      [
        { op: "open", at: 1, pid: 9, path: "/h/.mytool/config", created: true, truncated: true },
        { op: "write", at: 2, pid: 9, path: "/h/.mytool/config" },
      ],
      { inspector, baseline },
    );

    expect(effects.owned).toEqual([]);
    expect(effects.mutated).toEqual([{ path: "/h/.mytool/config", installedHash: HASH_B }]);
  });

  test("an overwrite carries the baseline's captured before metadata and restores from its bytes", async () => {
    const inspector = new FakeFsInspector([["/h/.mytool/config", file(HASH_B)]]);
    const baseline = new MemoryBaseline();
    baseline.setNode("/h/.mytool/config", { kind: "file", hash: HASH_A, size: 4, mode: 0o640 });
    const { result } = await run(
      [
        { op: "open", at: 1, pid: 9, path: "/h/.mytool/config", created: true, truncated: true },
        { op: "write", at: 2, pid: 9, path: "/h/.mytool/config" },
      ],
      { inspector, baseline },
    );

    // Both the truncating open and the write describe the pre-window state, so a restore can undo
    // the install's edit even though the original bytes are already gone by reconstruction time.
    const before = { kind: "file" as const, hash: HASH_A, size: 4, mode: 0o640 };
    expect(result.events.filter((event) => event.type === "write").map((event) => event.before)).toEqual([before, before]);

    const effects = normalizeJournal({
      journal: { backend: "linux-strace", completeness: "complete", events: result.events },
      backups: { enabled: true, sizeLimitBytes: 1024 },
      caseSensitive: true,
      availableBeforeImages: new Set([HASH_A]),
    });
    expect(effects.mutated).toEqual([
      { path: "/h/.mytool/config", beforeHash: HASH_A, installedHash: HASH_B, mode: 0o640, beforeBlob: HASH_A },
    ]);
  });

  test("an unlink of a captured pre-existing file carries its before metadata", async () => {
    const baseline = new MemoryBaseline();
    baseline.setNode("/h/old", { kind: "file", hash: HASH_A, size: 4, mode: 0o644 });
    const { result } = await run([{ op: "unlink", at: 1, pid: 9, path: "/h/old" }], { baseline });

    const unlinked = result.events.find((event) => event.type === "unlink");
    expect(unlinked?.before).toEqual({ kind: "file", hash: HASH_A, size: 4, mode: 0o644 });

    const effects = normalizeJournal({
      journal: { backend: "linux-strace", completeness: "complete", events: result.events },
      backups: { enabled: true, sizeLimitBytes: 1024 },
      caseSensitive: true,
      availableBeforeImages: new Set([HASH_A]),
    });
    expect(effects.deleted).toEqual([{ path: "/h/old", beforeHash: HASH_A, mode: 0o644, beforeBlob: HASH_A }]);
  });

  test("an unlinked pre-existing file is a deletion with its baseline kind", async () => {
    const { effects } = await run([{ op: "unlink", at: 1, pid: 9, path: "/h/old" }], {
      baseline: new MemoryBaseline([["/h/old", "file"]]),
    });

    expect(effects.deleted).toEqual([{ path: "/h/old" }]);
  });

  test("a rename reports a rename relationship", async () => {
    const inspector = new FakeFsInspector([["/h/new", file(HASH_A)]]);
    const baseline = new MemoryBaseline([["/h/old", "file"]]);
    const { effects } = await run([{ op: "rename", at: 1, pid: 9, from: "/h/old", to: "/h/new" }], { inspector, baseline });

    expect(effects.owned).toEqual([{ path: "/h/new", kind: "file", installedHash: HASH_A }]);
    expect(effects.diagnostics.some((diagnostic) => diagnostic.code === "rename")).toBe(true);
  });
});

describe("linux reconstruction: root boundaries", () => {
  test("a `..` segment inside the roots is normalized before the path is recorded", async () => {
    const { result } = await run([{ op: "mkdir", at: 1, pid: 9, path: "/h/a/../keep" }]);
    expect(result.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual(["/h/keep"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a path that is itself an observe root is accepted", async () => {
    const { result } = await run([{ op: "mkdir", at: 1, pid: 9, path: "/h" }]);
    expect(result.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual(["/h"]);
  });

  test("a symlinked parent that still resolves inside the roots is kept", async () => {
    const inspector = new FakeFsInspector().setResolution("/h/link", "/h/real");
    const { result } = await run([{ op: "mkdir", at: 1, pid: 9, path: "/h/link/out" }], { inspector });
    expect(result.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual(["/h/link/out"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a symlinked parent that resolves outside the roots is dropped with a diagnostic", async () => {
    const inspector = new FakeFsInspector().setResolution("/h/link", "/away");
    const { result } = await run([{ op: "mkdir", at: 1, pid: 9, path: "/h/link/out" }], { inspector });
    expect(result.events).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.includes("/h/link/out"))).toBe(true);
  });

  test("a `..` after a symlinked component resolves like the kernel, so an escape is dropped", async () => {
    // The kernel follows `link` first, so `/h/link/..` is `/` (not `/h`); the lexical form `/h/out`
    // must not be recorded.
    const inspector = new FakeFsInspector().setResolution("/h/link", "/away");
    const { result } = await run([{ op: "mkdir", at: 1, pid: 9, path: "/h/link/../out" }], { inspector });
    expect(result.events).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.includes("/h/link/../out"))).toBe(true);
  });

  test("the final component is not followed: a symlink inside the roots is its own object", async () => {
    const inspector = new FakeFsInspector([["/h/tool", { kind: "symlink", target: "/usr/bin/true" }]]).setResolution(
      "/h/tool",
      "/usr/bin/true",
    );
    const { result } = await run([{ op: "symlink", at: 1, pid: 9, path: "/h/tool", target: "/usr/bin/true" }], {
      inspector,
    });
    expect(result.events.map((event) => (event.type === "symlink" ? event.path : ""))).toEqual(["/h/tool"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a symlinked parent pointing outside the roots is dropped against the real filesystem", async () => {
    const base = await mkdtemp(join(tmpdir(), "tret-root-escape-"));
    const home = join(base, "home");
    const outside = join(base, "outside");
    try {
      await mkdir(home);
      await mkdir(outside);
      await symlink(outside, join(home, "esc"));

      const result = await reconstruct({
        traced: {
          records: [
            { op: "mkdir", at: 1, pid: 9, path: join(home, "esc", "evil") },
            { op: "mkdir", at: 2, pid: 9, path: join(home, "ok") },
          ],
          unsupported: [],
          diagnostics: [],
        },
        inspector: new RealFsInspector(),
        baseline: new MemoryBaseline(),
        roots: [home],
        fallbackAt: 1000,
      });

      expect(result.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual([join(home, "ok")]);
      expect(result.diagnostics.some((diagnostic) => diagnostic.includes(join(home, "esc", "evil")))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("linux reconstruction: scope and unsupported operations", () => {
  test("records outside the observe roots are dropped", async () => {
    const { result } = await run([
      { op: "mkdir", at: 1, pid: 9, path: "/h/keep" },
      { op: "mkdir", at: 2, pid: 9, path: "/etc/out" },
    ]);
    expect(result.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual(["/h/keep"]);
  });

  test("contents of skipped churn directories are dropped, like the baseline walk", async () => {
    const { result } = await run(
      [
        { op: "mkdir", at: 1, pid: 9, path: "/h/node_modules" },
        { op: "write", at: 2, pid: 9, path: "/h/node_modules/pkg/index.js" },
        { op: "write", at: 3, pid: 9, path: "/h/.cache/tool/blob" },
        { op: "write", at: 4, pid: 9, path: "/h/cache.log" },
        { op: "write", at: 5, pid: 9, path: "/h/.mytool/dist/bundle.js" },
      ],
      { inspector: new FakeFsInspector([["/h/.mytool/dist/bundle.js", file(HASH_A)]]) },
    );

    // The skipped directory itself is recorded (a final path segment is never excluded), its
    // contents are not — and a *file* whose name merely matches the cache pattern stays tracked.
    const made = result.events.filter((event) => event.type === "mkdir").map((event) => event.path);
    expect(made).toEqual(["/h/node_modules"]);
    const written = result.events.filter((event) => event.type === "write").map((event) => event.path);
    expect(written).toEqual(["/h/cache.log"]);
  });

  test("unsupported syscalls are reported as diagnostics and create no events", async () => {
    const { result } = await run([
      {
        op: "unsupported",
        at: 1,
        pid: 9,
        syscall: "mmap",
        reason: "memory-mapped file changes are not visible to the journal",
      },
    ]);
    expect(result.events).toEqual([]);
    expect(result.diagnostics).toEqual(["unsupported syscall mmap: memory-mapped file changes are not visible to the journal"]);
  });
});
