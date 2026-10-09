import { describe, expect, test } from "bun:test";
import { formatList, listRows } from "./list";
import type { RecordV3 } from "../types";

function v3Record(overrides: Partial<RecordV3> = {}): RecordV3 {
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
    ...overrides,
  };
}

describe("list rendering", () => {
  test("renders a v3 record with its completeness and owned/mutated/deleted counts", () => {
    const lines = formatList([v3Record({ deleted: [{ path: "/home/.config/gone" }] })]);

    expect(lines).toHaveLength(2);
    const header = lines[0] ?? "";
    for (const column of ["Name", "Capture", "Owned", "Mutated", "Deleted"]) {
      expect(header).toContain(column);
    }

    const [row] = listRows([v3Record({ deleted: [{ path: "/home/.config/gone" }] })]);
    expect(row).toMatchObject({ name: "mytool", completeness: "heuristic", owned: 1, mutated: 0, deleted: 1 });
    expect(lines[1]).toContain("mytool");
    expect(lines[1]).toContain("heuristic");
  });

  test("sorts rows by tool name", () => {
    const rows = listRows([v3Record({ id: "b", name: "zebra" }), v3Record({ id: "a", name: "alpha" })]);
    expect(rows.map((row) => row.name)).toEqual(["alpha", "zebra"]);
  });
});
