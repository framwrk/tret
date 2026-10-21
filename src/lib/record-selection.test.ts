import { describe, expect, test } from "bun:test";
import { formatSelectionCandidates, selectRecord } from "./record-selection";
import type { RecordV3 } from "../types";

// Record selection is the one place every single-record command (uninstall, forget, inspect,
// trace, update) resolves its argument, so these tests pin the contract they all rely on: an
// exact id always wins, an exact name resolves only when it is unique, and several same-named
// records are an error listing the candidates by id instead of a silent first-match.

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
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
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

describe("selectRecord", () => {
  test("requires a non-empty selector", () => {
    for (const selector of [undefined, "", "   ", "\t"]) {
      const selection = selectRecord([record()], selector);
      expect(selection.ok).toBe(false);
      if (selection.ok) return;
      expect(selection.reason).toBe("not-found");
      expect(selection.message).toBe("a tool name or record id is required");
      expect(selection.candidates).toEqual([]);
    }
  });

  test("an exact record id wins even when several records share the name", () => {
    const records = [record({ id: "rec-a", name: "dup" }), record({ id: "rec-b", name: "dup" })];
    const selection = selectRecord(records, "rec-b");
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.record.id).toBe("rec-b");
  });

  test("a unique name resolves to its record", () => {
    const records = [record({ id: "rec-a", name: "alpha" }), record({ id: "rec-b", name: "beta" })];
    const selection = selectRecord(records, "beta");
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.record.id).toBe("rec-b");
  });

  test("a name match is trimmed before lookup", () => {
    const selection = selectRecord([record({ name: "alpha" })], "  alpha  ");
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.record.name).toBe("alpha");
  });

  test("an unknown selector is not-found and names the selector", () => {
    const selection = selectRecord([record({ name: "alpha" })], "missing");
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.reason).toBe("not-found");
    expect(selection.message).toBe("no tracked install matches missing");
    expect(selection.candidates).toEqual([]);
  });

  test("several same-named records are ambiguous and list the candidates", () => {
    const records = [
      record({ id: "rec-b", name: "dup", installedAt: "2026-10-10T00:00:00.000Z" }),
      record({ id: "rec-a", name: "dup", installedAt: "2026-10-09T00:00:00.000Z" }),
    ];
    const selection = selectRecord(records, "dup");
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.reason).toBe("ambiguous");
    expect(selection.message).toBe("2 tracked installs are named dup; select one by record id");
    // Oldest install first, then id, so repeated runs list the same order.
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual(["rec-a", "rec-b"]);
  });

  test("candidates with the same install time order by id", () => {
    const records = [
      record({ id: "rec-z", name: "dup", installedAt: "2026-10-09T00:00:00.000Z" }),
      record({ id: "rec-a", name: "dup", installedAt: "2026-10-09T00:00:00.000Z" }),
    ];
    const selection = selectRecord(records, "dup");
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual(["rec-a", "rec-z"]);
  });

  test("a record whose name equals another record's id resolves by id first", () => {
    // The selector "rec-a" is both a record's name and another record's id; the id wins.
    const records = [record({ id: "rec-a", name: "alpha" }), record({ id: "rec-b", name: "rec-a" })];
    const selection = selectRecord(records, "rec-a");
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.record.name).toBe("alpha");
  });
});

describe("formatSelectionCandidates", () => {
  test("lists id, name, install date, and executable so a user can copy the id", () => {
    const selection = selectRecord([record({ id: "rec-123456", name: "dup", installedAt: "2026-10-09T12:34:56.000Z" })], "dup");
    // A single match is not a candidate list; build the ambiguous case instead.
    const ambiguous = selectRecord(
      [
        record({ id: "rec-123456", name: "dup", installedAt: "2026-10-09T12:34:56.000Z" }),
        record({ id: "rec-654321", name: "dup", installedAt: "2026-10-11T00:00:00.000Z" }),
      ],
      "dup",
    );
    expect(selection.ok).toBe(true);
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(formatSelectionCandidates(ambiguous)).toEqual([
      "rec-123456  dup  installed 2026-10-09  /home/.local/bin/mytool",
      "rec-654321  dup  installed 2026-10-11  /home/.local/bin/mytool",
    ]);
  });

  test("names a missing tracked binary instead of printing an empty path", () => {
    const selection = selectRecord(
      [
        record({ id: "rec-a", name: "dup", executable: "" }),
        record({ id: "rec-b", name: "dup", executable: "/home/.local/bin/dup" }),
      ],
      "dup",
    );
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(formatSelectionCandidates(selection)[0]).toBe("rec-a  dup  installed 2026-10-09  no tracked binary");
  });
});
