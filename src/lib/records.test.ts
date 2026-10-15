import {
  LEGACY_BACKEND,
  LegacyRecordWriteError,
  RecordMigrationError,
  isV3Record,
  migrateRecordFileV2ToV3,
  migrateRecordV2ToV3,
  saveRecord,
} from "./records";
import type { RecordV3, ToolRecord } from "../types";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { FileStorage } from "./store";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME_BACKUP = process.env.HOME;

function record(name: string): ToolRecord {
  return {
    name,
    source: "install",
    url: `https://example.com/${name}.sh`,
    installedAt: "2026-10-03T00:00:00.000Z",
    executable: `/home/.local/bin/${name}`,
    scriptSha256: "a".repeat(64),
    added: [`/home/.local/bin/${name}`],
    edited: [],
  };
}

afterEach(() => {
  process.env.HOME = HOME_BACKUP;
});

describe("legacy v2 writers are disabled", () => {
  test("a legacy write after a v3 migration cannot downgrade or corrupt the file", async () => {
    const home = mkdtempSync(join(tmpdir(), "tret-test-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".tret"), { recursive: true });
    writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 2, records: [record("ripgrep")] }));

    // The first read migrates the file to v3 in place.
    const storage = new FileStorage({ homeDir: home });
    await storage.loadRecords();

    expect(() => saveRecord(record("other"))).toThrow(LegacyRecordWriteError);

    const raw = JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8"));
    expect(raw.version).toBe(3);
    expect(raw.records).toHaveLength(1);
    expect(await storage.loadRecords()).toHaveLength(1);
  });
});

describe("v2 -> v3 migration", () => {
  test("maps added paths to legacy ownership and edited paths to non-restorable mutations", () => {
    const migrated = migrateRecordV2ToV3(record("ripgrep"));

    expect(migrated.owned).toEqual([{ path: "/home/.local/bin/ripgrep", kind: "unknown" }]);
    expect(migrated.mutated).toEqual([]);
    expect(migrated.deleted).toEqual([]);
    expect(migrated.capture).toEqual({
      backend: LEGACY_BACKEND,
      completeness: "heuristic",
      segments: [
        {
          kind: "install",
          startedAt: "2026-10-03T00:00:00.000Z",
          partialReason: "migrated from v2: no journal evidence",
        },
      ],
    });
    expect(migrated.privilege).toBe("user");
    expect(migrated.caseSensitive).toBe(false);
  });

  test("legacy ownership and mutations carry no hashes or before-images", () => {
    const migrated = migrateRecordV2ToV3({ ...record("ripgrep"), edited: ["/home/.zshrc"] });

    expect(migrated.owned).toEqual([{ path: "/home/.local/bin/ripgrep", kind: "unknown" }]);
    expect(migrated.mutated).toEqual([{ path: "/home/.zshrc" }]);
    for (const entry of [...migrated.owned, ...migrated.mutated]) {
      expect("installedHash" in entry ? entry.installedHash : undefined).toBeUndefined();
      expect("beforeHash" in entry ? entry.beforeHash : undefined).toBeUndefined();
      expect("beforeBlob" in entry ? entry.beforeBlob : undefined).toBeUndefined();
    }
  });

  test("a find record keeps its source, URL, and script hash", () => {
    const found: ToolRecord = { ...record("fd"), source: "find", url: "", scriptSha256: "" };
    const migrated = migrateRecordV2ToV3(found);

    expect(migrated.source).toBe("find");
    expect(migrated.url).toBe("");
    expect(migrated.scriptSha256).toBe("");
    expect(migrated.capture.segments[0]?.kind).toBe("find");
  });

  test("migration assigns a stable id derived from the record, not the bare name", () => {
    const first = migrateRecordV2ToV3(record("ripgrep"));
    const second = migrateRecordV2ToV3(record("ripgrep"));

    expect(first.id).toBe(second.id);
    expect(first.id).not.toBe("ripgrep");
    expect(first.id.startsWith("v2-")).toBe(true);
  });

  test("a v2 file migrates every entry and reports version 3", () => {
    const file = migrateRecordFileV2ToV3({
      version: 2,
      records: [
        { ...record("ripgrep"), added: ["/a", "/b"], edited: ["/c"] },
        { ...record("fd"), source: "find", url: "", scriptSha256: "" },
      ],
    });

    expect(file.version).toBe(3);
    expect(file.records).toHaveLength(2);
    expect(file.records[0]?.owned.map((entry) => entry.path)).toEqual(["/a", "/b"]);
    expect(file.records[0]?.mutated.map((entry) => entry.path)).toEqual(["/c"]);
    expect(file.records[1]?.source).toBe("find");
  });

  test("an already-v3 file passes through idempotently", () => {
    const v3 = migrateRecordFileV2ToV3({ version: 2, records: [record("ripgrep")] });
    expect(migrateRecordFileV2ToV3(v3)).toEqual(v3);
  });

  test("a v2 record saved before source existed is migrated as an install", () => {
    const legacy: Record<string, unknown> = { ...record("ripgrep") };
    delete legacy.source;

    const file = migrateRecordFileV2ToV3({ version: 2, records: [legacy] });
    expect(file.records[0]?.source).toBe("install");
  });

  test("malformed input throws instead of migrating to an empty file", () => {
    expect(() => migrateRecordFileV2ToV3({ version: 2, records: "not-an-array" })).toThrow(RecordMigrationError);
    expect(() => migrateRecordFileV2ToV3({ version: 2 })).toThrow(RecordMigrationError);
    expect(() => migrateRecordFileV2ToV3({ version: 1, records: [] })).toThrow(RecordMigrationError);
    expect(() => migrateRecordFileV2ToV3("nope")).toThrow(RecordMigrationError);
    expect(() => migrateRecordFileV2ToV3({ version: 2, records: [{ name: "x" }] })).toThrow(RecordMigrationError);
  });

  test("a malformed record reports which fields are wrong", () => {
    try {
      migrateRecordFileV2ToV3({ version: 2, records: [{ name: "x", added: "not-an-array" }] });
      throw new Error("expected migration to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordMigrationError);
      expect((error as RecordMigrationError).issues.length).toBeGreaterThan(0);
    }
  });

  test("a malformed v3 file is rejected too", () => {
    expect(() => migrateRecordFileV2ToV3({ version: 3, records: [{ id: "x" }] })).toThrow(RecordMigrationError);
  });
});

/** A fully shaped v3 record; overrides may still be made shape-invalid by the tests below. */
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
      backend: "linux-strace",
      completeness: "complete",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z", endedAt: "2026-10-09T00:00:01.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path: "/home/.local/bin/mytool", kind: "file", installedHash: "b".repeat(64) }],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

/** A record-like object with shape-invalid overrides; `isV3Record` takes `unknown` by design. */
function corrupt(overrides: Record<string, unknown>): unknown {
  return { ...v3Record(), ...overrides };
}

describe("deep v3 record validation", () => {
  test("accepts a fully shaped record and the partial record with no executable", () => {
    expect(isV3Record(v3Record())).toBe(true);
    // An empty executable is the v3 representation for a partial record with no discoverable one.
    expect(isV3Record(v3Record({ executable: "", scriptSha256: "" }))).toBe(true);
  });

  test("rejects owned entries with a relative path, an unknown kind, or a foreign link target", () => {
    expect(isV3Record(corrupt({ owned: [{ path: "bin/mytool", kind: "file" }] }))).toBe(false);
    expect(isV3Record(corrupt({ owned: [{ path: "/x", kind: "socket" }] }))).toBe(false);
    expect(isV3Record(corrupt({ owned: [{ path: "/x", kind: "file", linkTarget: "/y" }] }))).toBe(false);
    expect(isV3Record(v3Record({ owned: [{ path: "/x", kind: "symlink", linkTarget: "../y" }] }))).toBe(true);
  });

  test("rejects a fingerprint or before-image reference that is not a sha256", () => {
    expect(isV3Record(corrupt({ owned: [{ path: "/x", kind: "file", installedHash: "short" }] }))).toBe(false);
    expect(isV3Record(corrupt({ mutated: [{ path: "/x", beforeBlob: "blob-1" }] }))).toBe(false);
    expect(isV3Record(corrupt({ deleted: [{ path: "/x", beforeHash: "not-hex" }] }))).toBe(false);
    expect(isV3Record(v3Record({ mutated: [{ path: "/x", beforeHash: "c".repeat(64), beforeBlob: "d".repeat(64) }] }))).toBe(
      true,
    );
  });

  test("rejects capture segments that are empty, of an unknown kind, or missing a start time", () => {
    expect(isV3Record(corrupt({ capture: { backend: "x", completeness: "complete", segments: [] } }))).toBe(false);
    expect(
      isV3Record(
        corrupt({ capture: { backend: "x", completeness: "complete", segments: [{ kind: "prune", startedAt: "t" }] } }),
      ),
    ).toBe(false);
    expect(
      isV3Record(
        corrupt({ capture: { backend: "x", completeness: "complete", segments: [{ kind: "install", startedAt: "" }] } }),
      ),
    ).toBe(false);
  });

  test("rejects managed fields with a relative shared root and accepts them without one", () => {
    expect(isV3Record(corrupt({ managedBy: { manager: "npm", package: "mytool", globalRoot: ".npm-global" } }))).toBe(false);
    expect(isV3Record(corrupt({ managedInstall: { kind: "pi", layout: "releases-v1", root: "pi" } }))).toBe(false);
    expect(isV3Record(v3Record({ managedBy: { manager: "npm", package: "mytool" } }))).toBe(true);
  });

  test("a malformed nested v3 entry names the field at fault", () => {
    try {
      migrateRecordFileV2ToV3({ version: 3, records: [corrupt({ mutated: [{ path: "/x", beforeBlob: "blob-1" }] })] });
      throw new Error("expected validation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordMigrationError);
      expect((error as RecordMigrationError).issues).toContain("records[0].mutated[0].beforeBlob must be a sha256 hex string");
    }
  });

  test("a v2 file whose path cannot migrate to an absolute v3 entry fails closed", () => {
    try {
      migrateRecordFileV2ToV3({ version: 2, records: [{ ...record("ripgrep"), added: ["bin/ripgrep"] }] });
      throw new Error("expected migration to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordMigrationError);
      expect((error as RecordMigrationError).issues).toContain("records[0].owned[0].path must be an absolute path");
    }
  });
});
