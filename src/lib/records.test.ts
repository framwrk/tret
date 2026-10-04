import { afterEach, describe, expect, test } from "bun:test";
import { loadRecords, saveRecord } from "./records";
import { mkdtempSync, readFileSync } from "node:fs";
import type { ToolRecord } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME_BACKUP = process.env.HOME;

function record(name: string): ToolRecord {
  return {
    name,
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
});
