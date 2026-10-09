import type { UninstallAction, UninstallPlan, UninstallPlanner } from "./uninstall-planner";
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
    mutated: [{ path: "/home/.zshrc", beforeHash: "c".repeat(64), beforeBlob: "blob-1" }],
    deleted: [],
  };
}

/** A stub planner that emits one of every action, proving the plan union is implementable. */
class StubPlanner implements UninstallPlanner {
  async plan(record: RecordV3): Promise<UninstallPlan> {
    const actions: UninstallAction[] = [
      { action: "remove", path: record.owned[0]?.path ?? "/home/.local/bin/mytool", kind: "file" },
      { action: "restore", path: record.mutated[0]?.path ?? "/home/.zshrc", kind: "file", beforeBlob: "blob-1" },
      { action: "skip", path: "/home/.mytool/gone", reason: "absent" },
      { action: "conflict", path: "/home/.mytool/edited", reason: "modified" },
    ];
    return { recordId: record.id, tool: record.name, actions, requiresSudo: false, incomplete: true };
  }
}

describe("uninstall planner contract", () => {
  test("a plan can express remove, restore, skip, and conflict", async () => {
    const plan = await new StubPlanner().plan(record());

    expect(plan.actions.map((action) => action.action)).toEqual(["remove", "restore", "skip", "conflict"]);
    expect(plan.incomplete).toBe(true);
    expect(plan.requiresSudo).toBe(false);
  });

  test("the action union discriminates by its action field", () => {
    const actions: UninstallAction[] = [{ action: "conflict", path: "/home/.mytool/edited", reason: "diverged" }];
    const action = actions[0];
    if (!action) throw new Error("expected one action");

    switch (action.action) {
      case "remove":
      case "restore":
      case "skip":
        throw new Error("expected a conflict");
      case "conflict":
        expect(action.reason).toBe("diverged");
        break;
    }
  });
});
