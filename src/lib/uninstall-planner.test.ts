import type { UninstallAction, UninstallPlan, UninstallPlanner, UninstallVerification } from "./uninstall-planner";
import { VerifiedUninstallPlanner, formatUninstallPlan, inspectPath, unclaimSharedPath } from "./uninstall-planner";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

function record(): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "/home/.local/bin/mytool",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "macos-heuristic",
      completeness: "heuristic",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    privilege: "user",
    caseSensitive: false,
    owned: [{ path: "/home/.local/bin/mytool", kind: "file", installedHash: "b".repeat(64) }],
    mutated: [],
    deleted: [],
  };
}

const h = (char: string): string => char.repeat(64);

/** A verification map keyed by path; anything unlisted is absent. */
function inspector(map: Record<string, UninstallVerification>): (path: string) => UninstallVerification {
  return (path) => map[path] ?? { exists: false };
}

/** A child-listing map keyed by directory; anything unlisted is empty. */
function lister(map: Record<string, string[]>): (path: string) => string[] {
  return (path) => map[path] ?? [];
}

function planFor(
  record: RecordV3,
  state: Record<string, UninstallVerification>,
  options: {
    force?: boolean;
    otherRecords?: RecordV3[];
    list?: Record<string, string[]>;
    delegatedRoots?: string[];
    skipNonEmptyOwnedDirectories?: boolean;
  } = {},
): Promise<UninstallPlan> {
  const planner = new VerifiedUninstallPlanner(inspector(state), lister(options.list ?? {}));
  return planner.plan(record, {
    force: options.force,
    otherRecords: options.otherRecords,
    delegatedRoots: options.delegatedRoots,
    skipNonEmptyOwnedDirectories: options.skipNonEmptyOwnedDirectories,
  });
}

describe("VerifiedUninstallPlanner fingerprints", () => {
  test("removes an owned file whose installed fingerprint still matches", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.actions).toEqual([
      {
        action: "remove",
        path: "/h/bin/tool",
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
    ]);
    expect(plan.incomplete).toBe(false);
  });

  test("keeps a changed owned file and reports a modified conflict", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("d") } });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/bin/tool", reason: "modified" }]);
    expect(plan.incomplete).toBe(true);
  });

  test("force removes a changed owned file", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("d") } }, { force: true });

    expect(plan.actions).toEqual([
      {
        action: "remove",
        path: "/h/bin/tool",
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("d") },
      },
    ]);
    expect(plan.incomplete).toBe(false);
  });

  test("force does not remove a file whose fingerprint is unavailable", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("d") } }, { force: true });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/bin/tool", reason: "unverified" }]);
    expect(plan.incomplete).toBe(true);
  });

  test("an owned path with no recorded hash is unverified, not removed", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("d") } });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/bin/tool", reason: "unverified" }]);
  });

  test("a migrated unknown-kind path is never removed, even with force", async () => {
    const target = { ...record(), owned: [{ path: "/h/legacy", kind: "unknown" as const }] };
    const plan = await planFor(target, { "/h/legacy": { exists: true, kind: "file", hash: h("d") } }, { force: true });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/legacy", reason: "unverified" }]);
  });

  test("skips an already-absent owned path", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/gone", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, {});

    expect(plan.actions).toEqual([{ action: "skip", path: "/h/bin/gone", reason: "absent" }]);
    expect(plan.incomplete).toBe(false);
  });

  test("verifies a symlink by its recorded target, not the bytes it points at", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/link", kind: "symlink" as const, linkTarget: "/h/tool" }] };
    const match = await planFor(target, { "/h/bin/link": { exists: true, kind: "symlink", linkTarget: "/h/tool" } });
    expect(match.actions).toEqual([
      {
        action: "remove",
        path: "/h/bin/link",
        kind: "symlink",
        plannedState: { exists: true, kind: "symlink", linkTarget: "/h/tool" },
      },
    ]);

    const mismatch = await planFor(target, { "/h/bin/link": { exists: true, kind: "symlink", linkTarget: "/h/other" } });
    expect(mismatch.actions).toEqual([{ action: "conflict", path: "/h/bin/link", reason: "modified" }]);

    const forced = await planFor(
      target,
      { "/h/bin/link": { exists: true, kind: "symlink", linkTarget: "/h/other" } },
      { force: true },
    );
    expect(forced.actions).toEqual([
      {
        action: "remove",
        path: "/h/bin/link",
        kind: "symlink",
        plannedState: { exists: true, kind: "symlink", linkTarget: "/h/other" },
      },
    ]);
  });

  test("force does not remove a symlink whose target is unavailable", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/link", kind: "symlink" as const }] };
    const plan = await planFor(
      target,
      { "/h/bin/link": { exists: true, kind: "symlink", linkTarget: "/h/other" } },
      { force: true },
    );

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/bin/link", reason: "unverified" }]);
  });

  test("a recorded kind that no longer matches is a diverged conflict", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "directory" } });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/bin/tool", reason: "diverged" }]);
  });
});

describe("VerifiedUninstallPlanner directories", () => {
  test("removes owned files before their owned directory, deepest first", async () => {
    const target = {
      ...record(),
      owned: [
        { path: "/h/dir", kind: "directory" as const },
        { path: "/h/dir/tool", kind: "file" as const, installedHash: h("b") },
      ],
    };
    const plan = await planFor(
      target,
      { "/h/dir": { exists: true, kind: "directory" }, "/h/dir/tool": { exists: true, kind: "file", hash: h("b") } },
      { list: { "/h/dir": ["/h/dir/tool"] } },
    );

    expect(plan.actions).toEqual([
      {
        action: "remove",
        path: "/h/dir/tool",
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
      { action: "remove", path: "/h/dir", kind: "directory", plannedState: { exists: true, kind: "directory" } },
    ]);
    expect(plan.incomplete).toBe(false);
  });

  test("keeps an owned directory that still holds user files and reports a conflict", async () => {
    const target = { ...record(), owned: [{ path: "/h/dir", kind: "directory" as const }] };
    const plan = await planFor(
      target,
      { "/h/dir": { exists: true, kind: "directory" } },
      { list: { "/h/dir": ["/h/dir/user.txt"] } },
    );

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/dir", reason: "not-empty" }]);
    expect(plan.incomplete).toBe(true);
  });

  test("forced replacement skips a non-empty owned directory without recursing into it", async () => {
    const target = { ...record(), owned: [{ path: "/h/dir", kind: "directory" as const }] };
    const plan = await planFor(
      target,
      { "/h/dir": { exists: true, kind: "directory" } },
      { force: true, skipNonEmptyOwnedDirectories: true, list: { "/h/dir": ["/h/dir/other-tool.conf"] } },
    );

    // The shared directory and the other tool's file are left alone, and the leftover never blocks
    // the replacement record.
    expect(plan.actions).toEqual([{ action: "skip", path: "/h/dir", reason: "not-empty" }]);
    expect(plan.incomplete).toBe(false);
  });

  test("forced replacement still blocks diverged and unverified paths", async () => {
    const target = {
      ...record(),
      owned: [
        { path: "/h/dir", kind: "directory" as const },
        { path: "/h/diverged", kind: "file" as const, installedHash: h("b") },
        { path: "/h/unverified", kind: "file" as const },
      ],
    };
    const plan = await planFor(
      target,
      {
        "/h/dir": { exists: true, kind: "directory" },
        "/h/diverged": { exists: true, kind: "directory" },
        "/h/unverified": { exists: true, kind: "file", hash: h("d") },
      },
      { force: true, skipNonEmptyOwnedDirectories: true, list: { "/h/dir": ["/h/dir/other-tool.conf"] } },
    );

    expect(plan.actions).toEqual([
      { action: "skip", path: "/h/dir", reason: "not-empty" },
      { action: "conflict", path: "/h/diverged", reason: "diverged" },
      { action: "conflict", path: "/h/unverified", reason: "unverified" },
    ]);
    expect(plan.incomplete).toBe(true);
  });

  test("a kept owned child blocks its parent directory from being removed", async () => {
    const target = {
      ...record(),
      owned: [
        { path: "/h/dir", kind: "directory" as const },
        { path: "/h/dir/tool", kind: "file" as const, installedHash: h("b") },
      ],
    };
    const plan = await planFor(
      target,
      { "/h/dir": { exists: true, kind: "directory" }, "/h/dir/tool": { exists: true, kind: "file", hash: h("changed") } },
      { list: { "/h/dir": ["/h/dir/tool"] } },
    );

    expect(plan.actions).toEqual([
      { action: "conflict", path: "/h/dir/tool", reason: "modified" },
      { action: "conflict", path: "/h/dir", reason: "not-empty" },
    ]);
  });
});

describe("VerifiedUninstallPlanner delegated roots", () => {
  test("a delegated root counts as gone so an owned ancestor can be removed, not reported not-empty", async () => {
    const target = {
      ...record(),
      owned: [
        { path: "/h/agent", kind: "directory" as const },
        { path: "/h/agent/bin", kind: "directory" as const },
        { path: "/h/agent/bin/pi", kind: "file" as const, installedHash: h("b") },
      ],
    };
    const state = {
      "/h/agent": { exists: true, kind: "directory" as const },
      "/h/agent/bin": { exists: true, kind: "directory" as const },
      "/h/agent/bin/pi": { exists: true, kind: "file" as const, hash: h("b") },
    };
    // `agent` also holds the delegated managed root, whose untracked payload the record never owns.
    const list = {
      "/h/agent": ["/h/agent/bin", "/h/agent/install"],
      "/h/agent/bin": ["/h/agent/bin/pi"],
    };

    const without = await planFor(target, state, { list });
    expect(without.actions).toEqual([
      {
        action: "remove",
        path: "/h/agent/bin/pi",
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
      {
        action: "remove",
        path: "/h/agent/bin",
        kind: "directory",
        plannedState: { exists: true, kind: "directory" },
      },
      { action: "conflict", path: "/h/agent", reason: "not-empty" },
    ]);
    expect(without.incomplete).toBe(true);

    const withRoot = await planFor(target, state, { list, delegatedRoots: ["/h/agent/install"] });
    expect(withRoot.actions).toEqual([
      {
        action: "remove",
        path: "/h/agent/bin/pi",
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
      {
        action: "remove",
        path: "/h/agent/bin",
        kind: "directory",
        plannedState: { exists: true, kind: "directory" },
      },
      { action: "remove", path: "/h/agent", kind: "directory", plannedState: { exists: true, kind: "directory" } },
    ]);
    expect(withRoot.incomplete).toBe(false);
  });
});

describe("VerifiedUninstallPlanner restore and delete", () => {
  test("restores a mutation only while the installed state still matches", async () => {
    const target = {
      ...record(),
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b"), beforeBlob: "blob-1" }],
    };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.actions).toEqual([
      {
        action: "restore",
        path: "/h/rc",
        kind: "file",
        beforeBlob: "blob-1",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
    ]);
  });

  test("a restore carries the recorded pre-install mode of a mutation", async () => {
    const target = {
      ...record(),
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b"), beforeBlob: "blob-1", mode: 0o640 }],
    };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.actions).toEqual([
      {
        action: "restore",
        path: "/h/rc",
        kind: "file",
        beforeBlob: "blob-1",
        mode: 0o640,
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
    ]);
  });

  test("a restore carries the recorded pre-install mode of a deletion", async () => {
    const target = { ...record(), owned: [], mutated: [], deleted: [{ path: "/h/gone", beforeBlob: "blob-2", mode: 0o600 }] };
    const plan = await planFor(target, {});

    expect(plan.actions).toEqual([
      {
        action: "restore",
        path: "/h/gone",
        kind: "file",
        beforeBlob: "blob-2",
        mode: 0o600,
        plannedState: { exists: false },
      },
    ]);
  });

  test("preserves a diverged mutation and reports a conflict", async () => {
    const target = {
      ...record(),
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b"), beforeBlob: "blob-1" }],
    };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file", hash: h("user") } });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/rc", reason: "diverged" }]);
  });

  test("a mutation with no before-image is detect-only and does not block", async () => {
    const target = { ...record(), owned: [], mutated: [{ path: "/h/rc", installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.actions).toEqual([{ action: "detected", path: "/h/rc", kind: "mutated" }]);
    expect(plan.incomplete).toBe(false);
  });

  test("a diverged mutation with no before-image is still detect-only, not a blocking conflict", async () => {
    const target = { ...record(), owned: [], mutated: [{ path: "/h/rc", installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file", hash: h("user") } });

    expect(plan.actions).toEqual([{ action: "detected", path: "/h/rc", kind: "mutated" }]);
    expect(plan.incomplete).toBe(false);
  });

  test("an unreadable mutation is reported as unreadable", async () => {
    const target = {
      ...record(),
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b"), beforeBlob: "blob-1" }],
    };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file" } });

    expect(plan.actions).toEqual([{ action: "conflict", path: "/h/rc", reason: "unreadable" }]);
  });

  test("restores a recorded deletion only while the path is still absent", async () => {
    const target = { ...record(), owned: [], mutated: [], deleted: [{ path: "/h/gone", beforeBlob: "blob-2" }] };
    const restored = await planFor(target, {});
    expect(restored.actions).toEqual([
      { action: "restore", path: "/h/gone", kind: "file", beforeBlob: "blob-2", plannedState: { exists: false } },
    ]);

    const recreated = await planFor(target, { "/h/gone": { exists: true, kind: "file", hash: h("x") } });
    expect(recreated.actions).toEqual([{ action: "conflict", path: "/h/gone", reason: "diverged" }]);
  });

  test("a deletion with no before-image is detect-only and does not block", async () => {
    const target = { ...record(), owned: [], mutated: [], deleted: [{ path: "/h/gone" }] };
    const plan = await planFor(target, {});

    expect(plan.actions).toEqual([{ action: "detected", path: "/h/gone", kind: "deleted" }]);
    expect(plan.incomplete).toBe(false);
  });
});

describe("inspectPath non-regular nodes", () => {
  test("reports a FIFO as present but unverifiable, without reading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tret-fifo-"));
    try {
      const fifo = join(dir, "pipe");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

      expect(inspectPath(fifo)).toEqual({ exists: true, uid: process.getuid?.() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VerifiedUninstallPlanner shared ownership", () => {
  test("another record claiming the path blocks removal unless forced", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const state = { "/h/bin/tool": { exists: true, kind: "file", hash: h("b") } } satisfies Record<
      string,
      UninstallVerification
    >;
    const other: RecordV3 = {
      ...record(),
      id: "rec-2",
      name: "other",
      owned: [{ path: "/h/bin/tool", kind: "file", installedHash: h("b") }],
    };

    const blocked = await planFor(target, state, { otherRecords: [other] });
    expect(blocked.actions).toEqual([{ action: "conflict", path: "/h/bin/tool", reason: "shared-owner" }]);

    const forced = await planFor(target, state, { otherRecords: [other], force: true });
    expect(forced.actions).toEqual([
      {
        action: "remove",
        path: "/h/bin/tool",
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
    ]);
  });

  test("another record claiming a detect-only mutation still blocks unless forced (D4)", async () => {
    const target = { ...record(), owned: [], mutated: [{ path: "/h/rc", installedHash: h("b") }] };
    const state = { "/h/rc": { exists: true, kind: "file", hash: h("b") } } satisfies Record<string, UninstallVerification>;
    const other: RecordV3 = {
      ...record(),
      id: "rec-2",
      name: "other",
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b") }],
    };

    const blocked = await planFor(target, state, { otherRecords: [other] });
    expect(blocked.actions).toEqual([{ action: "conflict", path: "/h/rc", reason: "shared-owner" }]);
    expect(blocked.incomplete).toBe(true);

    // Forcing past D4 leaves the non-restorable change, which is then detect-only and non-blocking.
    const forced = await planFor(target, state, { otherRecords: [other], force: true });
    expect(forced.actions).toEqual([{ action: "detected", path: "/h/rc", kind: "mutated" }]);
    expect(forced.incomplete).toBe(false);
  });

  test("case-variant claims are shared only where a record's filesystem is case-insensitive (D10)", async () => {
    const target = {
      ...record(),
      caseSensitive: true,
      owned: [{ path: "/h/bin/Tool", kind: "file" as const, installedHash: h("b") }],
    };
    const state = { "/h/bin/Tool": { exists: true, kind: "file", hash: h("b") } } satisfies Record<
      string,
      UninstallVerification
    >;
    const other: RecordV3 = {
      ...record(),
      id: "rec-2",
      name: "other",
      caseSensitive: true,
      owned: [{ path: "/h/bin/tool", kind: "file", installedHash: h("b") }],
    };

    // Both filesystems are case-sensitive: the two spellings name different files.
    const distinct = await planFor(target, state, { otherRecords: [other] });
    expect(distinct.actions).toEqual([
      { action: "remove", path: "/h/bin/Tool", kind: "file", plannedState: { exists: true, kind: "file", hash: h("b") } },
    ]);

    // The other record's filesystem was case-insensitive, so its claim names this same file.
    const othersInsensitive = await planFor(target, state, { otherRecords: [{ ...other, caseSensitive: false }] });
    expect(othersInsensitive.actions).toEqual([{ action: "conflict", path: "/h/bin/Tool", reason: "shared-owner" }]);

    // So does the planned record's own filesystem being case-insensitive.
    const selfInsensitive = await planFor({ ...target, caseSensitive: false }, state, { otherRecords: [other] });
    expect(selfInsensitive.actions).toEqual([{ action: "conflict", path: "/h/bin/Tool", reason: "shared-owner" }]);
  });
});

describe("VerifiedUninstallPlanner sudo awareness", () => {
  test("a root-privileged record with unknown ownership requires sudo", async () => {
    const target = {
      ...record(),
      privilege: "root" as const,
      owned: [{ path: "/usr/local/bin/tool", kind: "file" as const, installedHash: h("b") }],
    };
    const plan = await planFor(target, { "/usr/local/bin/tool": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.requiresSudo).toBe(true);
  });

  test("a root-owned path requires sudo only when this process cannot write it", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("b"), uid: 0 } });
    const expected = process.getuid?.() !== 0;

    expect(plan.requiresSudo).toBe(expected);
  });

  test("a user-owned path never requires sudo", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("b"), uid: 501 } });

    expect(plan.requiresSudo).toBe(false);
  });
});

describe("dry-run parity", () => {
  test("planning is deterministic and dry-run enumerates the same actions as apply", async () => {
    const target = {
      ...record(),
      owned: [
        { path: "/h/dir", kind: "directory" as const },
        { path: "/h/dir/tool", kind: "file" as const, installedHash: h("b") },
        { path: "/h/bin/changed", kind: "file" as const, installedHash: h("b") },
      ],
      mutated: [{ path: "/h/rc", installedHash: h("b"), beforeBlob: "blob-1" }],
      deleted: [{ path: "/h/gone", beforeBlob: "blob-2" }],
    };
    const state = {
      "/h/dir": { exists: true, kind: "directory" as const },
      "/h/dir/tool": { exists: true, kind: "file" as const, hash: h("b") },
      "/h/bin/changed": { exists: true, kind: "file" as const, hash: h("changed") },
      "/h/rc": { exists: true, kind: "file" as const, hash: h("b") },
    };

    const first = await planFor(target, state, { list: { "/h/dir": ["/h/dir/tool"] } });
    const second = await planFor(target, state, { list: { "/h/dir": ["/h/dir/tool"] } });
    expect(second).toEqual(first);

    const dry = formatUninstallPlan(first, "dry-run");
    const real = formatUninstallPlan(first, "apply");

    // Every action is enumerated in both, in the same order, with only the verb differing. The
    // observed caveat leads the destructive lines, so a heuristic record is never shown as proven.
    expect(first.actions.map((action) => action.action)).toEqual(["remove", "conflict", "remove", "restore", "restore"]);
    expect(first.confidence).toBe("observed");
    expect(dry).toEqual([
      "note: these paths are observed, not proven to belong to this tool",
      "would remove /h/dir/tool (observed, not proven)",
      "conflict /h/bin/changed (modified)",
      "would remove /h/dir (observed, not proven)",
      "would restore /h/rc (observed, not proven)",
      "would restore /h/gone (observed, not proven)",
    ]);
    expect(real).toEqual([
      "note: these paths are observed, not proven to belong to this tool",
      "remove /h/dir/tool (observed, not proven)",
      "keep /h/bin/changed (modified)",
      "remove /h/dir (observed, not proven)",
      "restore /h/rc (observed, not proven)",
      "restore /h/gone (observed, not proven)",
    ]);
  });

  test("a complete capture plans the same actions without the observed caveat", async () => {
    const target = {
      ...record(),
      capture: { backend: "linux-fanotify", completeness: "complete" as const, segments: [] },
      owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }],
    };

    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.confidence).toBe("proven");
    expect(plan.actions).toEqual([
      { action: "remove", path: "/h/bin/tool", kind: "file", plannedState: { exists: true, kind: "file", hash: h("b") } },
    ]);
    expect(formatUninstallPlan(plan, "dry-run")).toEqual(["would remove /h/bin/tool"]);
  });

  test("an observed plan with no destructive actions omits the caveat", async () => {
    const target = {
      ...record(),
      owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }],
    };

    const plan = await planFor(target, {
      "/h/bin/tool": { exists: true, kind: "file", hash: h("changed") },
    });

    expect(plan.actions.map((action) => action.action)).toEqual(["conflict"]);
    expect(formatUninstallPlan(plan, "dry-run")).toEqual(["conflict /h/bin/tool (modified)"]);
  });
});

describe("unclaimSharedPath", () => {
  const sharedFile = "/h/bin/tool";

  function twoOwners(caseSensitive = true): { target: RecordV3; other: RecordV3 } {
    const entry = { path: sharedFile, kind: "file" as const, installedHash: h("b") };
    return {
      target: { ...record(), caseSensitive, owned: [entry] },
      other: { ...record(), id: "rec-2", name: "other", caseSensitive, owned: [entry] },
    };
  }

  test("drops one owned claim and names the remaining owner", () => {
    const { target, other } = twoOwners();

    const result = unclaimSharedPath(target, sharedFile, [target, other]);

    expect(result).toEqual({
      ok: true,
      record: { ...target, owned: [] },
      removed: ["owned"],
      remaining: [{ id: "rec-2", name: "other" }],
    });
    // The input record is not mutated; the caller saves the returned record.
    expect(target.owned).toHaveLength(1);
  });

  test("drops mutated and deleted claims too, leaving the other record's evidence alone", () => {
    const target = {
      ...record(),
      caseSensitive: true,
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b") }],
      deleted: [{ path: "/h/gone" }],
    };
    const other = {
      ...record(),
      id: "rec-2",
      name: "other",
      caseSensitive: true,
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b") }],
      deleted: [{ path: "/h/gone" }],
    };

    expect(unclaimSharedPath(target, "/h/rc", [target, other])).toEqual({
      ok: true,
      record: { ...target, mutated: [], deleted: [{ path: "/h/gone" }] },
      removed: ["mutated"],
      remaining: [{ id: "rec-2", name: "other" }],
    });
    expect(unclaimSharedPath(target, "/h/gone", [target, other])).toEqual({
      ok: true,
      record: { ...target, mutated: [{ path: "/h/rc", installedHash: h("b") }], deleted: [] },
      removed: ["deleted"],
      remaining: [{ id: "rec-2", name: "other" }],
    });
    expect(other.mutated).toHaveLength(1);
    expect(other.deleted).toHaveLength(1);
  });

  test("refuses a path the selected record does not claim", () => {
    const { target, other } = twoOwners();
    expect(unclaimSharedPath(target, "/h/bin/elsewhere", [target, other])).toEqual({
      ok: false,
      reason: "not-claimed",
    });
  });

  test("refuses when the selected record is the only claimant", () => {
    const { target } = twoOwners();
    const unrelated = { ...record(), id: "rec-3", name: "unrelated", owned: [] };

    expect(unclaimSharedPath(target, sharedFile, [target, unrelated])).toEqual({
      ok: false,
      reason: "not-shared",
    });
  });

  test("case variants resolve only where D10 treats the spellings as one path", () => {
    const target = {
      ...record(),
      caseSensitive: true,
      owned: [{ path: "/h/bin/Tool", kind: "file" as const, installedHash: h("b") }],
    };
    const otherSensitive = {
      ...record(),
      id: "rec-2",
      name: "other",
      caseSensitive: true,
      owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }],
    };

    // Both filesystems are case-sensitive: the two spellings are different paths.
    expect(unclaimSharedPath(target, "/h/bin/tool", [target, otherSensitive])).toEqual({
      ok: false,
      reason: "not-claimed",
    });

    // The other record was on a case-insensitive filesystem, so its spelling is this same file.
    const otherInsensitive = { ...otherSensitive, caseSensitive: false };
    const result = unclaimSharedPath(target, "/h/bin/tool", [target, otherInsensitive]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.owned).toEqual([]);
    expect(result.remaining).toEqual([{ id: "rec-2", name: "other" }]);
  });

  test("a case-insensitive record drops a case variant when an exact claimant remains", () => {
    const target = {
      ...record(),
      caseSensitive: false,
      owned: [{ path: "/h/bin/Tool", kind: "file" as const, installedHash: h("b") }],
    };
    const other = {
      ...record(),
      id: "rec-2",
      name: "other",
      caseSensitive: true,
      owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }],
    };

    const result = unclaimSharedPath(target, "/h/bin/tool", [target, other]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.owned).toEqual([]);
  });

  test("after the claim is dropped, the same planner removes or detects without force (D4)", async () => {
    const { target, other } = twoOwners();
    const state = { [sharedFile]: { exists: true, kind: "file" as const, hash: h("b") } };

    const blocked = await planFor(target, state, { otherRecords: [target, other] });
    expect(blocked.actions).toEqual([{ action: "conflict", path: sharedFile, reason: "shared-owner" }]);
    expect(blocked.incomplete).toBe(true);

    const resolved = unclaimSharedPath(target, sharedFile, [target, other]);
    if (!resolved.ok) throw new Error("expected the shared claim to be resolved");

    // The record that gave up the claim has nothing to remove for this path.
    const resigned = await planFor(resolved.record, state, { otherRecords: [resolved.record, other] });
    expect(resigned.actions).toEqual([]);
    expect(resigned.incomplete).toBe(false);

    // The remaining owner plans an ordinary removal, with no forced fingerprint bypass.
    const owner = await planFor(other, state, { otherRecords: [resolved.record, other] });
    expect(owner.actions).toEqual([
      {
        action: "remove",
        path: sharedFile,
        kind: "file",
        plannedState: { exists: true, kind: "file", hash: h("b") },
      },
    ]);
    expect(owner.incomplete).toBe(false);
  });

  test("a shared detect-only mutation becomes the existing non-blocking detected action", async () => {
    const target = { ...record(), caseSensitive: true, owned: [], mutated: [{ path: "/h/rc", installedHash: h("b") }] };
    const other = {
      ...record(),
      id: "rec-2",
      name: "other",
      caseSensitive: true,
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b") }],
    };
    const state = { "/h/rc": { exists: true, kind: "file" as const, hash: h("b") } };

    const blocked = await planFor(target, state, { otherRecords: [target, other] });
    expect(blocked.actions).toEqual([{ action: "conflict", path: "/h/rc", reason: "shared-owner" }]);

    const resolved = unclaimSharedPath(target, "/h/rc", [target, other]);
    if (!resolved.ok) throw new Error("expected the shared claim to be resolved");
    const owner = await planFor(other, state, { otherRecords: [resolved.record, other] });

    expect(owner.actions).toEqual([{ action: "detected", path: "/h/rc", kind: "mutated" }]);
    expect(owner.incomplete).toBe(false);
  });
});

describe("uninstall planner contract", () => {
  test("a plan can express remove, restore, skip, detected, and conflict", async () => {
    const stub: UninstallPlanner = {
      async plan(target: RecordV3): Promise<UninstallPlan> {
        const actions: UninstallAction[] = [
          {
            action: "remove",
            path: target.owned[0]?.path ?? "/home/.local/bin/mytool",
            kind: "file",
            plannedState: { exists: true, kind: "file", hash: h("b") },
          },
          {
            action: "restore",
            path: target.mutated[0]?.path ?? "/home/.zshrc",
            kind: "file",
            beforeBlob: "blob-1",
            plannedState: { exists: true, kind: "file", hash: h("b") },
          },
          { action: "skip", path: "/home/.mytool/gone", reason: "absent" },
          { action: "detected", path: "/home/.mytool/churn", kind: "mutated" },
          { action: "conflict", path: "/home/.mytool/edited", reason: "modified" },
        ];
        return {
          recordId: target.id,
          tool: target.name,
          actions,
          confidence: "observed",
          requiresSudo: false,
          incomplete: true,
        };
      },
    };
    const plan = await stub.plan(record());

    expect(plan.actions.map((action) => action.action)).toEqual(["remove", "restore", "skip", "detected", "conflict"]);
    expect(plan.incomplete).toBe(true);
    expect(plan.requiresSudo).toBe(false);
  });

  test("the action union discriminates by its action field", () => {
    const actions: UninstallAction[] = [{ action: "detected", path: "/home/.mytool/churn", kind: "mutated" }];
    const action = actions[0];
    if (!action) throw new Error("expected one action");

    switch (action.action) {
      case "remove":
      case "restore":
      case "skip":
      case "conflict":
        throw new Error("expected a detect-only action");
      case "detected":
        expect(action.kind).toBe("mutated");
        break;
    }
  });
});
