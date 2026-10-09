import type { UninstallAction, UninstallPlan, UninstallPlanner, UninstallVerification } from "./uninstall-planner";
import { VerifiedUninstallPlanner, formatUninstallPlan } from "./uninstall-planner";
import { describe, expect, test } from "bun:test";
import type { RecordV3 } from "../types";

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
  options: { force?: boolean; otherRecords?: RecordV3[]; list?: Record<string, string[]> } = {},
): Promise<UninstallPlan> {
  const planner = new VerifiedUninstallPlanner(inspector(state), lister(options.list ?? {}));
  return planner.plan(record, { force: options.force, otherRecords: options.otherRecords });
}

describe("VerifiedUninstallPlanner fingerprints", () => {
  test("removes an owned file whose installed fingerprint still matches", async () => {
    const target = { ...record(), owned: [{ path: "/h/bin/tool", kind: "file" as const, installedHash: h("b") }] };
    const plan = await planFor(target, { "/h/bin/tool": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.actions).toEqual([{ action: "remove", path: "/h/bin/tool", kind: "file" }]);
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

    expect(plan.actions).toEqual([{ action: "remove", path: "/h/bin/tool", kind: "file" }]);
    expect(plan.incomplete).toBe(false);
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
    expect(match.actions).toEqual([{ action: "remove", path: "/h/bin/link", kind: "symlink" }]);

    const mismatch = await planFor(target, { "/h/bin/link": { exists: true, kind: "symlink", linkTarget: "/h/other" } });
    expect(mismatch.actions).toEqual([{ action: "conflict", path: "/h/bin/link", reason: "modified" }]);
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
      { action: "remove", path: "/h/dir/tool", kind: "file" },
      { action: "remove", path: "/h/dir", kind: "directory" },
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

describe("VerifiedUninstallPlanner restore and delete", () => {
  test("restores a mutation only while the installed state still matches", async () => {
    const target = {
      ...record(),
      owned: [],
      mutated: [{ path: "/h/rc", installedHash: h("b"), beforeBlob: "blob-1" }],
    };
    const plan = await planFor(target, { "/h/rc": { exists: true, kind: "file", hash: h("b") } });

    expect(plan.actions).toEqual([
      { action: "restore", path: "/h/rc", kind: "file", beforeBlob: "blob-1", expect: "installed", installedHash: h("b") },
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
      { action: "restore", path: "/h/gone", kind: "file", beforeBlob: "blob-2", expect: "absent" },
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
    expect(forced.actions).toEqual([{ action: "remove", path: "/h/bin/tool", kind: "file" }]);
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

    // Every action is enumerated in both, in the same order, with only the verb differing.
    expect(first.actions.map((action) => action.action)).toEqual(["remove", "conflict", "remove", "restore", "restore"]);
    expect(dry).toEqual([
      "would remove /h/dir/tool",
      "conflict /h/bin/changed (modified)",
      "would remove /h/dir",
      "would restore /h/rc",
      "would restore /h/gone",
    ]);
    expect(real).toEqual([
      "remove /h/dir/tool",
      "keep /h/bin/changed (modified)",
      "remove /h/dir",
      "restore /h/rc",
      "restore /h/gone",
    ]);
  });
});

describe("uninstall planner contract", () => {
  test("a plan can express remove, restore, skip, detected, and conflict", async () => {
    const stub: UninstallPlanner = {
      async plan(target: RecordV3): Promise<UninstallPlan> {
        const actions: UninstallAction[] = [
          { action: "remove", path: target.owned[0]?.path ?? "/home/.local/bin/mytool", kind: "file" },
          { action: "restore", path: target.mutated[0]?.path ?? "/home/.zshrc", kind: "file", beforeBlob: "blob-1" },
          { action: "skip", path: "/home/.mytool/gone", reason: "absent" },
          { action: "detected", path: "/home/.mytool/churn", kind: "mutated" },
          { action: "conflict", path: "/home/.mytool/edited", reason: "modified" },
        ];
        return { recordId: target.id, tool: target.name, actions, requiresSudo: false, incomplete: true };
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
