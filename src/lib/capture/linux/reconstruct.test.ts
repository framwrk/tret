import { FakeFsInspector, MemoryBaseline } from "./inspect";
import { describe, expect, test } from "bun:test";
import type { BackupPolicy } from "../normalize";
import type { ReconstructInput } from "./reconstruct";
import type { TracerRecord } from "./raw";
import { normalizeJournal } from "../../journal/normalize";
import { reconstruct } from "./reconstruct";

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

describe("linux reconstruction: scope and unsupported operations", () => {
  test("records outside the observe roots are dropped", async () => {
    const { result } = await run([
      { op: "mkdir", at: 1, pid: 9, path: "/h/keep" },
      { op: "mkdir", at: 2, pid: 9, path: "/etc/out" },
    ]);
    expect(result.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual(["/h/keep"]);
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
