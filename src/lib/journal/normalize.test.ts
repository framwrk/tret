import type { Journal, JournalEvent, JournalEventInput } from "../capture/events";
import { describe, expect, test } from "bun:test";
import type { BackupPolicy } from "../capture/normalize";
import { normalizeJournal } from "./normalize";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function journal(events: JournalEventInput[], overrides: Partial<Journal> = {}): Journal {
  return {
    backend: "fake",
    completeness: "complete",
    events: events.map((event, seq) => ({ ...event, seq, at: seq }) as JournalEvent),
    ...overrides,
  };
}

function normalize(
  events: JournalEventInput[],
  options: { backups?: BackupPolicy; caseSensitive?: boolean; journal?: Partial<Journal> } = {},
) {
  return normalizeJournal({
    journal: journal(events, options.journal),
    backups: options.backups ?? { enabled: false, sizeLimitBytes: 1024 * 1024 },
    caseSensitive: options.caseSensitive ?? true,
  });
}

describe("journal normalization: ownership", () => {
  test("a created file that is written is owned with its installed hash", () => {
    const effects = normalize([
      { type: "create", path: "/home/.mytool/bin/mytool", after: { kind: "file", hash: HASH_A } },
      {
        type: "write",
        path: "/home/.mytool/bin/mytool",
        before: { kind: "file", hash: HASH_A },
        after: { kind: "file", hash: HASH_A },
      },
    ]);

    expect(effects.owned).toEqual([{ path: "/home/.mytool/bin/mytool", kind: "file", installedHash: HASH_A }]);
    expect(effects.mutated).toEqual([]);
    expect(effects.deleted).toEqual([]);
  });

  test("a created symlink is owned by target, never followed content", () => {
    const effects = normalize([
      {
        type: "symlink",
        path: "/home/.local/bin/mytool",
        target: "/home/.mytool/bin/mytool",
        after: { kind: "symlink", target: "/home/.mytool/bin/mytool" },
      },
    ]);

    expect(effects.owned).toEqual([
      { path: "/home/.local/bin/mytool", kind: "symlink", linkTarget: "/home/.mytool/bin/mytool" },
    ]);
  });

  test("nested directories and files are each owned, parents ordered before children", () => {
    const effects = normalize([
      { type: "mkdir", path: "/home/.mytool", after: { kind: "directory" } },
      { type: "mkdir", path: "/home/.mytool/bin", after: { kind: "directory" } },
      { type: "create", path: "/home/.mytool/bin/mytool", after: { kind: "file", hash: HASH_A } },
    ]);

    expect(effects.owned).toEqual([
      { path: "/home/.mytool", kind: "directory" },
      { path: "/home/.mytool/bin", kind: "directory" },
      { path: "/home/.mytool/bin/mytool", kind: "file", installedHash: HASH_A },
    ]);
  });

  test("case-insensitive paths collapse to one entry, keeping the latest spelling", () => {
    const effects = normalize(
      [
        { type: "create", path: "/home/Tool", after: { kind: "file", hash: HASH_A } },
        {
          type: "write",
          path: "/home/tool",
          before: { kind: "file", hash: HASH_A },
          after: { kind: "file", hash: HASH_A },
        },
      ],
      { caseSensitive: false },
    );

    expect(effects.owned).toEqual([{ path: "/home/tool", kind: "file", installedHash: HASH_A }]);
  });
});

describe("journal normalization: mutation and deletion", () => {
  test("overwriting a pre-existing file records a restorable mutation when backups allow", () => {
    const effects = normalize(
      [
        {
          type: "write",
          path: "/home/.config/tool.conf",
          before: { kind: "file", hash: HASH_A, size: 10 },
          after: { kind: "file", hash: HASH_B, size: 12 },
        },
      ],
      { backups: { enabled: true, sizeLimitBytes: 1024 } },
    );

    expect(effects.mutated).toEqual([
      { path: "/home/.config/tool.conf", beforeHash: HASH_A, installedHash: HASH_B, beforeBlob: HASH_A },
    ]);
  });

  test("an overwrite keeps hashes but no before-image when backups are off", () => {
    const effects = normalize([
      {
        type: "write",
        path: "/f",
        before: { kind: "file", hash: HASH_A, size: 10 },
        after: { kind: "file", hash: HASH_B, size: 12 },
      },
    ]);

    expect(effects.mutated).toEqual([{ path: "/f", beforeHash: HASH_A, installedHash: HASH_B }]);
  });

  test("an over-limit overwrite keeps hashes but claims no restorable before-image", () => {
    const effects = normalize(
      [
        {
          type: "write",
          path: "/big",
          before: { kind: "file", hash: HASH_A, size: 2048 },
          after: { kind: "file", hash: HASH_B, size: 2048 },
        },
      ],
      { backups: { enabled: true, sizeLimitBytes: 1024 } },
    );

    expect(effects.mutated[0]?.beforeHash).toBe(HASH_A);
    expect(effects.mutated[0]?.beforeBlob).toBeUndefined();
  });

  test("deleting a pre-existing file records it with its prior hash and before-image", () => {
    const effects = normalize([{ type: "unlink", path: "/home/.old", before: { kind: "file", hash: HASH_A, size: 5 } }], {
      backups: { enabled: true, sizeLimitBytes: 1024 },
    });

    expect(effects.deleted).toEqual([{ path: "/home/.old", beforeHash: HASH_A, beforeBlob: HASH_A }]);
  });

  test("removing a pre-existing directory records a deletion", () => {
    const effects = normalize([{ type: "rmdir", path: "/home/.mytool/cache", before: { kind: "directory" } }]);

    expect(effects.deleted).toEqual([{ path: "/home/.mytool/cache" }]);
  });

  test("chmod on a pre-existing file records a non-restorable mutation", () => {
    const effects = normalize([{ type: "chmod", path: "/home/script.sh", after: { mode: 0o755 } }]);

    expect(effects.mutated).toEqual([{ path: "/home/script.sh" }]);
    expect(effects.diagnostics.map((diagnostic) => diagnostic.code)).toContain("unsupported");
  });

  test("chmod on a file the install created stays owned without a separate mutation", () => {
    const effects = normalize([
      { type: "create", path: "/home/.mytool/bin/mytool", after: { kind: "file", hash: HASH_A } },
      { type: "chmod", path: "/home/.mytool/bin/mytool", after: { mode: 0o755 } },
    ]);

    expect(effects.owned).toEqual([{ path: "/home/.mytool/bin/mytool", kind: "file", installedHash: HASH_A }]);
    expect(effects.mutated).toEqual([]);
    expect(effects.diagnostics).toEqual([]);
  });
});

describe("journal normalization: sequence collapsing", () => {
  test("a temporary file created and renamed over a destination collapses to the destination", () => {
    const effects = normalize([
      { type: "create", path: "/home/.mytool/.install.tmp", after: { kind: "file", hash: HASH_A } },
      {
        type: "rename",
        from: "/home/.mytool/.install.tmp",
        to: "/home/.mytool/bin/mytool",
        after: { kind: "file", hash: HASH_A },
      },
    ]);

    expect(effects.owned).toEqual([{ path: "/home/.mytool/bin/mytool", kind: "file", installedHash: HASH_A }]);
    expect(effects.owned.some((entry) => entry.path.includes("tmp"))).toBe(false);
    expect(effects.mutated).toEqual([]);
    expect(effects.diagnostics.map((diagnostic) => diagnostic.code)).toContain("temp-rename");
  });

  test("a temporary file written without prior state then renamed collapses too", () => {
    const effects = normalize([
      { type: "write", path: "/home/.tmp123", after: { kind: "file", hash: HASH_A } },
      {
        type: "rename",
        from: "/home/.tmp123",
        to: "/home/.local/bin/tool",
        after: { kind: "file", hash: HASH_A },
      },
    ]);

    expect(effects.owned).toEqual([{ path: "/home/.local/bin/tool", kind: "file", installedHash: HASH_A }]);
    expect(effects.mutated).toEqual([]);
    expect(effects.diagnostics.some((diagnostic) => diagnostic.code === "temp-rename")).toBe(true);
  });

  test("renaming a pre-existing file removes the source and creates the destination", () => {
    const effects = normalize([
      {
        type: "rename",
        from: "/home/old",
        to: "/home/new",
        before: { kind: "file", hash: HASH_A },
        after: { kind: "file", hash: HASH_A },
      },
    ]);

    expect(effects.deleted).toEqual([{ path: "/home/old", beforeHash: HASH_A }]);
    expect(effects.owned).toEqual([{ path: "/home/new", kind: "file", installedHash: HASH_A }]);
    expect(effects.diagnostics.map((diagnostic) => diagnostic.code)).toContain("rename");
  });

  test("renaming over a known destination records a mutation with the destination's prior state", () => {
    const effects = normalize([
      {
        type: "write",
        path: "/home/tool",
        before: { kind: "file", hash: HASH_A },
        after: { kind: "file", hash: HASH_A },
      },
      { type: "create", path: "/home/.tmp", after: { kind: "file", hash: HASH_B } },
      { type: "rename", from: "/home/.tmp", to: "/home/tool", after: { kind: "file", hash: HASH_B } },
    ]);

    expect(effects.mutated).toEqual([{ path: "/home/tool", beforeHash: HASH_A, installedHash: HASH_B }]);
    expect(effects.owned).toEqual([]);
    expect(effects.diagnostics.some((diagnostic) => diagnostic.code === "temp-rename")).toBe(true);
  });

  test("a newly written file followed by a delete cancels out", () => {
    const effects = normalize([
      { type: "write", path: "/home/.mytool/junk", after: { kind: "file", hash: HASH_A } },
      { type: "unlink", path: "/home/.mytool/junk", before: { kind: "file", hash: HASH_A } },
    ]);

    expect(effects.owned).toEqual([]);
    expect(effects.deleted).toEqual([]);
    expect(effects.diagnostics.map((diagnostic) => diagnostic.code)).toContain("create-delete");
  });

  test("a create followed by a delete cancels out", () => {
    const effects = normalize([
      { type: "create", path: "/home/.mytool/junk", after: { kind: "file", hash: HASH_A } },
      { type: "unlink", path: "/home/.mytool/junk", before: { kind: "file", hash: HASH_A } },
    ]);

    expect(effects.owned).toEqual([]);
    expect(effects.deleted).toEqual([]);
    expect(effects.diagnostics.map((diagnostic) => diagnostic.code)).toContain("create-delete");
  });

  test("a directory created and removed cancels out", () => {
    const effects = normalize([
      { type: "mkdir", path: "/home/.mytool/cache", after: { kind: "directory" } },
      { type: "rmdir", path: "/home/.mytool/cache", before: { kind: "directory" } },
    ]);

    expect(effects.owned).toEqual([]);
    expect(effects.deleted).toEqual([]);
    expect(effects.diagnostics.some((diagnostic) => diagnostic.code === "create-delete")).toBe(true);
  });
});

describe("journal normalization: content comparison", () => {
  test("a content change is detected even when mtime and size are unchanged", () => {
    const effects = normalize([
      {
        type: "write",
        path: "/f",
        before: { kind: "file", hash: HASH_A, size: 10, mtimeMs: 100 },
        after: { kind: "file", hash: HASH_B, size: 10, mtimeMs: 100 },
      },
    ]);

    expect(effects.mutated).toEqual([{ path: "/f", beforeHash: HASH_A, installedHash: HASH_B }]);
  });

  test("unchanged content with noisy metadata is not recorded as a mutation", () => {
    const effects = normalize([
      {
        type: "write",
        path: "/f",
        before: { kind: "file", hash: HASH_A, size: 10, mtimeMs: 100 },
        after: { kind: "file", hash: HASH_A, size: 99, mtimeMs: 999 },
      },
    ]);

    expect(effects.mutated).toEqual([]);
    expect(effects.owned).toEqual([]);
  });

  test("without hashes, equal mtime and size skip a recording as unchanged", () => {
    const effects = normalize([
      {
        type: "write",
        path: "/f",
        before: { kind: "file", size: 10, mtimeMs: 100 },
        after: { kind: "file", size: 10, mtimeMs: 100 },
      },
    ]);

    expect(effects.mutated).toEqual([]);
  });

  test("without hashes, a size change records a mutation", () => {
    const effects = normalize([
      {
        type: "write",
        path: "/f",
        before: { kind: "file", size: 10, mtimeMs: 100 },
        after: { kind: "file", size: 11, mtimeMs: 100 },
      },
    ]);

    expect(effects.mutated).toEqual([{ path: "/f" }]);
  });
});

describe("journal normalization: coverage", () => {
  test("an incomplete journal reports a coverage diagnostic", () => {
    const effects = normalize([], { journal: { completeness: "partial", partialReason: "uid transition" } });

    expect(effects.diagnostics).toEqual([
      { code: "coverage", message: "capture completeness is partial: uid transition", paths: [] },
    ]);
  });

  test("a complete journal reports no coverage diagnostic", () => {
    const effects = normalize([]);
    expect(effects.diagnostics).toEqual([]);
  });
});
