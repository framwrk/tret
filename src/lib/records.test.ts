import {
  LEGACY_BACKEND,
  RecordMigrationError,
  loadRecords,
  migrateRecordFileV2ToV3,
  migrateRecordV2ToV3,
  saveRecord,
} from "./records";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { ToolRecord } from "../types";
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

describe("records", () => {
  test("saves a record to the records file", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "tret-test-"));

    saveRecord(record("ripgrep"));

    const file = JSON.parse(readFileSync(join(process.env.HOME!, ".tret", "records.json"), "utf8"));
    expect(file).toEqual({ version: 2, records: [record("ripgrep")] });
  });

  test("loads saved records", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "tret-test-"));

    saveRecord(record("ripgrep"));

    expect(loadRecords()).toEqual({ version: 2, records: [record("ripgrep")] });
  });

  test("replaces an earlier record for the same tool name", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "tret-test-"));

    saveRecord(record("ripgrep"));
    saveRecord({ ...record("ripgrep"), installedAt: "2026-10-03T01:00:00.000Z" });

    expect(loadRecords().records).toEqual([{ ...record("ripgrep"), installedAt: "2026-10-03T01:00:00.000Z" }]);
  });

  test("keeps other tools' records", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "tret-test-"));

    saveRecord(record("ripgrep"));
    saveRecord(record("fd"));

    expect(loadRecords().records).toEqual([record("ripgrep"), record("fd")]);
  });

  test("counts a missing records file as no records", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "tret-test-"));

    expect(loadRecords()).toEqual({ version: 2, records: [] });
  });

  test("defaults the source of a record saved before source existed to install", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "tret-test-"));
    mkdirSync(join(process.env.HOME!, ".tret"), { recursive: true });
    writeFileSync(
      join(process.env.HOME!, ".tret", "records.json"),
      JSON.stringify({ version: 2, records: [{ ...record("ripgrep"), source: undefined }] }),
    );

    expect(loadRecords().records).toEqual([record("ripgrep")]);
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
