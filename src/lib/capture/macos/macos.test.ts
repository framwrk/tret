import type { Journal, JournalEvent, JournalEventInput } from "../events";
import type { ScopedNode, ScopedSnapshot } from "./scoped";
import { describe, expect, test } from "bun:test";
import { diffScopedSnapshots, filesToHash, scopedPathKey } from "./scoped";
import { isVolatileChurnPath, macosHeuristicRoots } from "./scope";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { MACOS_PLATFORM } from "../../platform";
import { MacosHeuristicCaptureBackend } from "./backend";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NO_BACKUPS = { enabled: false, sizeLimitBytes: 1024 * 1024 };

function node(path: string, kind: ScopedNode["kind"], overrides: Partial<ScopedNode> = {}): ScopedNode {
  return { path, kind, size: 1, mtimeMs: 1, mode: 0o644, inode: 1, ...overrides };
}

function snap(nodes: ScopedNode[], caseSensitive = true): ScopedSnapshot {
  return { entries: new Map(nodes.map((entry) => [scopedPathKey(entry.path, caseSensitive), entry])), errors: [] };
}

function journal(events: JournalEventInput[], overrides: Partial<Journal> = {}): Journal {
  return {
    backend: "macos-heuristic",
    completeness: "heuristic",
    events: events.map((event, seq) => ({ ...event, seq, at: seq }) as JournalEvent),
    ...overrides,
  };
}

function normalize(events: JournalEventInput[]) {
  return normalizeJournal({ journal: journal(events), backups: NO_BACKUPS, caseSensitive: true });
}

describe("macOS scope roots", () => {
  test("derive from the platform table (D3)", () => {
    const roots = macosHeuristicRoots({ home: "/Users/tester" });
    expect(roots).toContain("/opt/homebrew/bin");
    expect(roots).toContain("/usr/local/bin");
    expect(roots).toContain("/Users/tester/.config");
    expect(roots).toContain("/Users/tester/.local/bin");
    expect(roots).toContain("/Users/tester/.zshrc");
    expect(roots).toContain("/Users/tester/.bashrc");
    expect(roots).toEqual([...roots].sort());
    expect(new Set(roots).size).toBe(roots.length);
  });

  test("honor user include/exclude additions (D3)", () => {
    const roots = macosHeuristicRoots({
      home: "/Users/tester",
      include: ["/Users/tester/.mytool"],
      exclude: ["/Users/tester/.cache"],
    });
    expect(roots).toContain("/Users/tester/.mytool");
    expect(roots).not.toContain("/Users/tester/.cache");
  });

  test("the trimmed capture root set keeps real install surfaces and drops volatile Library subtrees (D3 revision)", () => {
    const roots = macosHeuristicRoots({ home: "/Users/tester" });
    const expected = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/tester/.bashrc",
      "/Users/tester/.bash_profile",
      "/Users/tester/.config",
      "/Users/tester/.local/bin",
      "/Users/tester/.local/lib",
      "/Users/tester/.local/share",
      "/Users/tester/.local/state",
      "/Users/tester/.profile",
      "/Users/tester/.zshenv",
      "/Users/tester/.zprofile",
      "/Users/tester/.zshrc",
      "/Users/tester/Library/Application Support",
      "/Users/tester/Library/LaunchAgents",
    ];
    expect(roots).toEqual(expected.sort());
    for (const dropped of [
      "/Users/tester/.cache",
      "/Users/tester/Library/Caches",
      "/Users/tester/Library/Containers",
      "/Users/tester/Library/HTTPStorages",
      "/Users/tester/Library/Logs",
      "/Users/tester/Library/Preferences",
      "/Users/tester/Library/Saved Application State",
      "/Users/tester/Library/WebKit",
    ]) {
      expect(roots).not.toContain(dropped);
    }
  });
});

describe("macOS volatile churn skip (defect #2)", () => {
  test("recognizes sidecar and journal churn while leaving real files alone", () => {
    for (const path of [
      "/Users/t/Library/Application Support/com.raycast.macos/main.db-wal",
      "/Users/t/Library/Application Support/com.raycast.macos/main.db-shm",
      "/Users/t/Library/HTTPStorages/com.x/sqlite-wal",
      "/Users/t/Library/HTTPStorages/com.x/sqlite-shm",
      "/Users/t/Library/Application Support/acme/WebStorage/QuotaManager-journal",
      "/Users/t/Library/Application Support/acme/IndexedDB/store/000024.log",
    ]) {
      expect(isVolatileChurnPath(path)).toBe(true);
    }
    expect(isVolatileChurnPath("/Users/t/Library/Application Support/acme/config.json")).toBe(false);
    expect(isVolatileChurnPath("/Users/t/Library/Application Support/acme/main.db")).toBe(false);
    expect(isVolatileChurnPath("/Users/t/Library/Application Support/acme/IndexedDB/store/MANIFEST-000001")).toBe(false);
    expect(isVolatileChurnPath("/Users/t/Library/LaunchAgents/com.acme.plist")).toBe(false);
  });

  test("churn created during the window is not emitted as an event", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-churn-"));
    try {
      const appSupport = join(root, "Library/Application Support/acme");
      mkdirSync(join(appSupport, "IndexedDB/store"), { recursive: true });
      const backend = new MacosHeuristicCaptureBackend();
      const session = await backend.start({
        pid: process.pid,
        privilege: "user",
        roots: [join(root, "Library/Application Support")],
      });
      writeFileSync(join(appSupport, "main.db-wal"), "churn");
      writeFileSync(join(appSupport, "WebStorage-journal"), "churn");
      writeFileSync(join(appSupport, "IndexedDB/store/000024.log"), "churn");
      const journal = await session.stop();
      expect(journal.events).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creations in kept real targets are recorded as owned", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-keep-"));
    try {
      for (const dir of [".local/bin", ".config", "Library/LaunchAgents"]) mkdirSync(join(root, dir), { recursive: true });
      const backend = new MacosHeuristicCaptureBackend();
      const session = await backend.start({
        pid: process.pid,
        privilege: "user",
        roots: [join(root, ".local/bin"), join(root, ".config"), join(root, "Library/LaunchAgents")],
      });
      writeFileSync(join(root, ".local/bin/acme"), "bin");
      writeFileSync(join(root, ".config/acme"), "conf");
      writeFileSync(join(root, "Library/LaunchAgents/com.acme.plist"), "plist");
      const journal = await session.stop();
      const owned = normalizeJournal({ journal, backups: NO_BACKUPS, caseSensitive: backend.caseSensitive }).owned.map(
        (entry) => entry.path,
      );
      expect(owned).toContain(join(root, ".local/bin/acme"));
      expect(owned).toContain(join(root, ".config/acme"));
      expect(owned).toContain(join(root, "Library/LaunchAgents/com.acme.plist"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("macOS scoped snapshot diff", () => {
  test("a created file becomes an owned entry with its installed hash", () => {
    const events = diffScopedSnapshots(snap([]), snap([node("/s/.mytool/bin/t", "file", { hash: HASH_A })]));
    expect(events).toEqual([
      { type: "create", path: "/s/.mytool/bin/t", after: { kind: "file", size: 1, mode: 0o644, mtimeMs: 1, hash: HASH_A } },
    ]);
    expect(normalize(events).owned).toEqual([{ path: "/s/.mytool/bin/t", kind: "file", installedHash: HASH_A }]);
  });

  test("a changed pre-existing file becomes a non-restorable mutation", () => {
    const before = snap([node("/s/.config/tool.conf", "file", { size: 2, mtimeMs: 10 })]);
    const after = snap([node("/s/.config/tool.conf", "file", { size: 20, mtimeMs: 20, hash: HASH_B })]);
    const events = diffScopedSnapshots(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "write", path: "/s/.config/tool.conf" });
    expect(normalize(events).mutated).toEqual([{ path: "/s/.config/tool.conf", installedHash: HASH_B }]);
  });

  test("a deleted file becomes a deletion with no before-hash", () => {
    const before = snap([node("/s/.mytool/gone.txt", "file", { size: 9 })]);
    const events = diffScopedSnapshots(before, snap([]));
    expect(events).toMatchObject([{ type: "unlink", path: "/s/.mytool/gone.txt" }]);
    expect(normalize(events).deleted).toEqual([{ path: "/s/.mytool/gone.txt" }]);
  });

  test("a kind change is emitted as a removal before a creation", () => {
    const before = snap([node("/s/x", "file", { size: 1 })]);
    const after = snap([node("/s/x", "directory", { mode: 0o755 })]);
    const events = diffScopedSnapshots(before, after);
    expect(events.map((event) => event.type)).toEqual(["unlink", "mkdir"]);
    const effects = normalize(events);
    expect(effects.mutated).toEqual([{ path: "/s/x" }]);
    expect(effects.owned).toEqual([]);
    expect(effects.deleted).toEqual([]);
  });

  test("a mode change becomes a chmod mutation and is not hashed", () => {
    const before = snap([node("/s/mytool", "file", { mode: 0o644 })]);
    const after = snap([node("/s/mytool", "file", { mode: 0o755 })]);
    const events = diffScopedSnapshots(before, after);
    expect(events).toEqual([{ type: "chmod", path: "/s/mytool", before: { mode: 0o644 }, after: { mode: 0o755 } }]);
    expect(normalize(events).mutated).toEqual([{ path: "/s/mytool" }]);
  });

  test("a created symlink is owned by its target, never followed", () => {
    const target = "/s/.mytool/bin/mytool";
    const events = diffScopedSnapshots(snap([]), snap([node("/s/.local/bin/mytool", "symlink", { linkTarget: target })]));
    expect(events).toEqual([
      {
        type: "symlink",
        path: "/s/.local/bin/mytool",
        target,
        after: { kind: "symlink", target, mode: 0o644 },
      },
    ]);
    expect(normalize(events).owned).toEqual([{ path: "/s/.local/bin/mytool", kind: "symlink", linkTarget: target }]);
  });

  test("nested directory creations are ordered parents before children", () => {
    const created = [
      node("/s/.mytool/share/doc/README", "file", { hash: HASH_A }),
      node("/s/.mytool/share", "directory"),
      node("/s/.mytool/share/doc", "directory"),
    ];
    const events = diffScopedSnapshots(snap([]), snap(created));
    expect(events.map((event) => event.type)).toEqual(["mkdir", "mkdir", "create"]);
    expect(events.map((event) => ("path" in event ? event.path : undefined))).toEqual([
      "/s/.mytool/share",
      "/s/.mytool/share/doc",
      "/s/.mytool/share/doc/README",
    ]);
  });

  test("only created or stamp-changed files are queued for hashing", () => {
    const before = snap([
      node("/s/unchanged", "file", { size: 4, mtimeMs: 1 }),
      node("/s/changed", "file", { size: 4, mtimeMs: 1 }),
      node("/s/mode-only", "file", { size: 4, mtimeMs: 1, mode: 0o644 }),
      node("/s/dir", "directory"),
      node("/s/link", "symlink", { linkTarget: "/s/unchanged" }),
    ]);
    const after = snap([
      node("/s/unchanged", "file", { size: 4, mtimeMs: 1 }),
      node("/s/changed", "file", { size: 8, mtimeMs: 2 }),
      node("/s/mode-only", "file", { size: 4, mtimeMs: 1, mode: 0o755 }),
      node("/s/dir", "directory"),
      node("/s/link", "symlink", { linkTarget: "/s/unchanged" }),
      node("/s/created", "file", { size: 1, mtimeMs: 3 }),
    ]);
    expect(filesToHash(before, after)).toEqual(["/s/changed", "/s/created"]);
  });
});

describe("macOS case behavior (D10)", () => {
  test("the default comparison is case-insensitive and collapses case variants", () => {
    const before = snap([node("/Scope/Tool", "file", { size: 2, mtimeMs: 1 })], false);
    const after = snap([node("/scope/tool", "file", { size: 20, mtimeMs: 2, hash: HASH_B })], false);
    const events = diffScopedSnapshots(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "write", path: "/scope/tool" });
  });

  test("a case-sensitive comparison keeps case variants distinct", () => {
    const before = snap([node("/Scope/Tool", "file", { size: 2, mtimeMs: 1 })], true);
    const after = snap([node("/scope/tool", "file", { size: 20, mtimeMs: 2, hash: HASH_B })], true);
    expect(diffScopedSnapshots(before, after).map((event) => event.type)).toEqual(["unlink", "create"]);
  });

  test("the backend defaults to the macOS table's case behavior", () => {
    expect(new MacosHeuristicCaptureBackend().caseSensitive).toBe(MACOS_PLATFORM.case.defaultCaseSensitive);
  });
});

describe("macOS completeness labeling", () => {
  test("the backend names and labels itself heuristic (D1)", async () => {
    const backend = new MacosHeuristicCaptureBackend();
    expect(backend.name).toBe("macos-heuristic");
    expect(backend.completeness).toBe("heuristic");
    const journal = await (await backend.start({ pid: 1, privilege: "user", roots: [] })).stop();
    expect(journal.completeness).toBe("heuristic");
    expect(journal.partialReason).toContain("no scope roots");
  });

  test("normalization reports the heuristic coverage in diagnostics", () => {
    const effects = normalizeJournal({ journal: journal([]), backups: NO_BACKUPS, caseSensitive: true });
    expect(effects.diagnostics).toEqual([{ code: "coverage", message: "capture completeness is heuristic", paths: [] }]);
  });
});
