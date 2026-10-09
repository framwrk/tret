import type { RecordFileV3, RecordV3 } from "./types";
import { describe, expect, test } from "bun:test";

describe("record v3 shape", () => {
  test("separates owned, mutated, and deleted with capture, privilege, and case metadata", () => {
    const record: RecordV3 = {
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
        segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z", partialReason: "heuristic scan" }],
      },
      privilege: "root",
      caseSensitive: false,
      owned: [
        { path: "/home/.mytool", kind: "directory" },
        { path: "/home/.local/bin/mytool", kind: "file", installedHash: "b".repeat(64) },
        { path: "/home/.local/bin/mytool-link", kind: "symlink", linkTarget: "/home/.mytool/bin/mytool" },
      ],
      mutated: [{ path: "/home/.zshrc", beforeHash: "c".repeat(64), installedHash: "d".repeat(64), beforeBlob: "blob-1" }],
      deleted: [{ path: "/home/.old", beforeHash: "e".repeat(64), beforeBlob: "blob-2" }],
    };

    expect(record.capture.completeness).toBe("heuristic");
    expect(record.capture.segments).toHaveLength(1);
    expect(record.privilege).toBe("root");
    expect(record.caseSensitive).toBe(false);
    expect(record.owned.map((entry) => entry.kind)).toEqual(["directory", "file", "symlink"]);
    expect(record.owned[2]?.linkTarget).toBe("/home/.mytool/bin/mytool");
    expect(record.mutated[0]?.beforeBlob).toBe("blob-1");
    expect(record.deleted[0]?.path).toBe("/home/.old");

    const file: RecordFileV3 = { version: 3, records: [record] };
    expect(file.version).toBe(3);
    expect(file.records).toHaveLength(1);
  });
});
