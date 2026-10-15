import type { OwnedEntry, RecordV3 } from "../types";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { VerifiedUninstallPlanner } from "./uninstall-planner";
import { adoptedEntries } from "./adoption";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-adopt-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A minimal find record whose owned paths come from `adoptedEntries`. */
function adoptRecord(owned: OwnedEntry[]): RecordV3 {
  return {
    id: "rec-adopt",
    name: "adoptme",
    source: "find",
    url: "",
    installedAt: "2026-10-15T00:00:00.000Z",
    executable: owned[0]?.path ?? "",
    scriptSha256: "",
    capture: {
      backend: "find",
      completeness: "heuristic",
      segments: [
        {
          kind: "find",
          startedAt: "2026-10-15T00:00:00.000Z",
          partialReason: "adopted by tret find: no install journal exists",
        },
      ],
    },
    privilege: "user",
    caseSensitive: true,
    owned,
    mutated: [],
    deleted: [],
  };
}

describe("adoptedEntries", () => {
  test("records a single file path with its content fingerprint", () => {
    const dir = makeDir();
    const file = join(dir, "tool");
    writeFileSync(file, "#!/bin/sh\n");

    const entries = adoptedEntries([file]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: file, kind: "file" });
    expect(entries[0]?.installedHash).toBeDefined();
  });

  test("inventories a folder down to its contents without following symlinks", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "tool"), "#!/bin/sh\n");
    writeFileSync(join(dir, "notes.txt"), "hi\n");
    symlinkSync("bin", join(dir, "link"));

    const entries = adoptedEntries([dir]);

    expect(entries.map((entry) => entry.path)).toEqual([
      dir,
      join(dir, "bin"),
      join(dir, "bin", "tool"),
      join(dir, "link"),
      join(dir, "notes.txt"),
    ]);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get(dir)?.kind).toBe("directory");
    expect(byPath.get(join(dir, "bin"))?.kind).toBe("directory");
    expect(byPath.get(join(dir, "bin", "tool"))?.installedHash).toBeDefined();
    expect(byPath.get(join(dir, "notes.txt"))?.installedHash).toBeDefined();
    expect(byPath.get(join(dir, "link"))).toMatchObject({ kind: "symlink", linkTarget: "bin" });
    // The link target is not adopted through the link, only where it actually lives.
    expect(entries.map((entry) => entry.path)).not.toContain(join(dir, "link", "tool"));
  });

  test("a populated adopted folder uninstalls what is verified and explains the survivor", async () => {
    const root = makeDir();
    const sub = join(root, "sub");
    mkdirSync(sub);
    const keep = join(root, "a.txt");
    const edited = join(root, "b.txt");
    const nested = join(sub, "c.txt");
    writeFileSync(keep, "keep\n");
    writeFileSync(edited, "before\n");
    writeFileSync(nested, "nested\n");

    const record = adoptRecord(adoptedEntries([root]));
    // The user edits one file after adoption; the record still holds the installed fingerprint.
    writeFileSync(edited, "user edit\n");

    const plan = await new VerifiedUninstallPlanner().plan(record);

    expect(plan.actions.map((action) => [action.action, action.path])).toEqual([
      ["remove", nested],
      ["remove", keep],
      ["conflict", edited],
      ["remove", sub],
      ["conflict", root],
    ]);
    expect(plan.actions[2]).toMatchObject({ reason: "modified" });
    // The folder survives only because the edited file does; it is never recursively deleted.
    expect(plan.actions[4]).toMatchObject({ reason: "not-empty" });
    expect(plan.incomplete).toBe(true);
  });
});
