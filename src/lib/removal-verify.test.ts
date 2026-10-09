import { afterAll, describe, expect, test } from "bun:test";
import { applyUninstallPlan, reduceRecordForRetry } from "./removal";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import type { Storage } from "./storage";
import { VerifiedUninstallPlanner } from "./uninstall-planner";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tret-uninstall-"));
  homes.push(home);
  return home;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function storageReturning(blobs: Record<string, Uint8Array>): Pick<Storage, "getBlob"> {
  return {
    async getBlob(id: string): Promise<Uint8Array | undefined> {
      return blobs[id];
    },
  };
}

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "/home/.local/bin/mytool",
    scriptSha256: "a".repeat(64),
    capture: { backend: "macos-heuristic", completeness: "heuristic", segments: [] },
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

const planner = new VerifiedUninstallPlanner();

describe("applyUninstallPlan removals", () => {
  test("removes a file whose fingerprint matched at plan and apply time", async () => {
    const home = testHome();
    const file = join(home, "tool");
    writeFileSync(file, "installed");
    const target = record({ owned: [{ path: file, kind: "file", installedHash: sha256("installed") }] });

    const plan = await planner.plan(target);
    expect(plan.actions).toEqual([{ action: "remove", path: file, kind: "file" }]);

    const result = await applyUninstallPlan(plan, { storage: storageReturning({}) });
    expect(result.removed).toEqual([file]);
    expect(result.incomplete).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  test("refuses to remove a directory that gained a user file after planning", async () => {
    const home = testHome();
    const dir = join(home, "d");
    mkdirSync(dir);
    const target = record({ owned: [{ path: dir, kind: "directory" }] });

    const plan = await planner.plan(target);
    expect(plan.actions).toEqual([{ action: "remove", path: dir, kind: "directory" }]);

    // The plan is verified, but the disk changed between planning and applying.
    writeFileSync(join(dir, "user.txt"), "mine");

    const result = await applyUninstallPlan(plan, { storage: storageReturning({}) });
    expect(result.conflicts).toEqual([dir]);
    expect(result.incomplete).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "user.txt"), "utf8")).toBe("mine");
  });
});

describe("applyUninstallPlan detect-only", () => {
  test("reports a non-restorable mutation without changing it or blocking", async () => {
    const home = testHome();
    const file = join(home, "churn");
    writeFileSync(file, "churn");
    const target = record({ mutated: [{ path: file, installedHash: sha256("churn") }] });

    const plan = await planner.plan(target);
    expect(plan.actions).toEqual([{ action: "detected", path: file, kind: "mutated" }]);

    const result = await applyUninstallPlan(plan, { storage: storageReturning({}) });
    expect(result.detected).toEqual([file]);
    expect(result.removed).toEqual([]);
    expect(result.incomplete).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("churn");
  });

  test("reports a non-restorable deletion without recreating it or blocking", async () => {
    const home = testHome();
    const file = join(home, "gone");
    const target = record({ deleted: [{ path: file }] });

    const plan = await planner.plan(target);
    expect(plan.actions).toEqual([{ action: "detected", path: file, kind: "deleted" }]);

    const result = await applyUninstallPlan(plan, { storage: storageReturning({}) });
    expect(result.detected).toEqual([file]);
    expect(result.incomplete).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

describe("applyUninstallPlan restores", () => {
  test("restores a verified mutation from its before-image, overwriting the installed bytes", async () => {
    const home = testHome();
    const file = join(home, "rc");
    writeFileSync(file, "installed");
    const target = record({ mutated: [{ path: file, installedHash: sha256("installed"), beforeBlob: "b1" }] });

    const plan = await planner.plan(target);
    expect(plan.actions[0]?.action).toBe("restore");

    const result = await applyUninstallPlan(plan, { storage: storageReturning({ b1: bytes("before") }) });
    expect(result.restored).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("before");
  });

  test("preserves a mutation edited after planning instead of overwriting it", async () => {
    const home = testHome();
    const file = join(home, "rc");
    writeFileSync(file, "installed");
    const target = record({ mutated: [{ path: file, installedHash: sha256("installed"), beforeBlob: "b1" }] });

    const plan = await planner.plan(target);
    writeFileSync(file, "user-edit");

    const result = await applyUninstallPlan(plan, { storage: storageReturning({ b1: bytes("before") }) });
    expect(result.conflicts).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("user-edit");
  });

  test("a missing before-image blob leaves the installed file in place", async () => {
    const home = testHome();
    const file = join(home, "rc");
    writeFileSync(file, "installed");
    const target = record({ mutated: [{ path: file, installedHash: sha256("installed"), beforeBlob: "b1" }] });

    const plan = await planner.plan(target);
    const result = await applyUninstallPlan(plan, { storage: storageReturning({}) });

    expect(result.conflicts).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("installed");
  });

  test("restores a recorded deletion by recreating the absent path", async () => {
    const home = testHome();
    const file = join(home, "gone");
    const target = record({ deleted: [{ path: file, beforeBlob: "b2" }] });

    const plan = await planner.plan(target);
    const result = await applyUninstallPlan(plan, { storage: storageReturning({ b2: bytes("original") }) });

    expect(result.restored).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("preserves a deleted path a user recreated after planning", async () => {
    const home = testHome();
    const file = join(home, "gone");
    const target = record({ deleted: [{ path: file, beforeBlob: "b2" }] });

    const plan = await planner.plan(target);
    writeFileSync(file, "recreated");

    const result = await applyUninstallPlan(plan, { storage: storageReturning({ b2: bytes("original") }) });
    expect(result.conflicts).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("recreated");
  });
});

describe("partial retries", () => {
  test("keeps only the survivors so a retry never re-verifies what already succeeded", async () => {
    const home = testHome();
    const good = join(home, "good");
    const bad = join(home, "bad");
    writeFileSync(good, "good");
    writeFileSync(bad, "changed");
    const target = record({
      owned: [
        { path: good, kind: "file", installedHash: sha256("good") },
        { path: bad, kind: "file", installedHash: sha256("original") },
      ],
    });

    const plan = await planner.plan(target);
    const result = await applyUninstallPlan(plan, { storage: storageReturning({}) });

    expect(result.removed).toEqual([good]);
    expect(result.conflicts).toEqual([bad]);
    expect(result.incomplete).toBe(true);

    const reduced = reduceRecordForRetry(target, result);
    expect(reduced.owned.map((entry) => entry.path)).toEqual([bad]);

    // The retried plan sees only the survivor: no false conflict for the already-removed file.
    const replan = await planner.plan(reduced);
    expect(replan.actions).toEqual([{ action: "conflict", path: bad, reason: "modified" }]);
  });

  test("drops restored mutations and deletions from the retry record", () => {
    const target = record({
      mutated: [{ path: "/h/rc", installedHash: sha256("installed"), beforeBlob: "b1" }],
      deleted: [{ path: "/h/gone", beforeBlob: "b2" }],
    });
    const result = {
      outcomes: [],
      removed: [],
      restored: ["/h/rc", "/h/gone"],
      skipped: [],
      detected: [],
      conflicts: [],
      failed: [],
      incomplete: false,
    };

    const reduced = reduceRecordForRetry(target, result);
    expect(reduced.mutated).toEqual([]);
    expect(reduced.deleted).toEqual([]);
  });
});
