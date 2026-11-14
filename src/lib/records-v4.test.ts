import { candidateEffects, observedRecord, readRecordFile, validateRecordFileV4 } from "./records-v4";
import { expect, test } from "bun:test";
import type { RecordV3 } from "../types";
import { migrateRecordFileV2ToV3 } from "./records";

function record(): RecordV3 {
  return {
    id: "example",
    name: "example",
    source: "install",
    url: "https://example.com/install",
    installedAt: "2026-11-11T00:00:00Z",
    executable: "/tmp/bin/example",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "linux-strace",
      completeness: "complete",
      segments: [{ kind: "install", startedAt: "2026-11-11T00:00:00Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path: "/tmp/bin/example", kind: "file", installedHash: "b".repeat(64) }],
    mutated: [{ path: "/tmp/config", beforeBlob: "c".repeat(64), installedHash: "d".repeat(64) }],
    deleted: [],
  };
}

test("legacy complete labels and injected optional authority cannot manufacture authorization", () => {
  const legacy = { ...record(), revision: 999, evidence: [{ authority: "user-approved" }] };
  const raw = { version: 3, sequence: 999, records: [legacy] };
  const before = JSON.stringify(raw);
  const normalized = readRecordFile(raw);
  expect(normalized.sequence).toBe(0);
  expect(normalized.records[0]?.revision).toBe(0);
  expect(normalized.records[0]?.evidence.map((entry) => [entry.authority, entry.attribution, entry.origin])).toEqual([
    ["none", "unknown", "legacy-v3"],
    ["none", "unknown", "legacy-v3"],
  ]);
  expect(normalized.records[0]?.mutated[0]?.beforeBlob).toBe("c".repeat(64));
  expect(JSON.stringify(raw)).toBe(before);
});

test("v3 readers reject the semantic version boundary; v4 round trips exact evidence", () => {
  const file = { version: 4 as const, sequence: 1, records: [observedRecord(record(), 1, "capture")] };
  expect(readRecordFile(file)).toEqual(file);
  expect(() => migrateRecordFileV2ToV3(file)).toThrow("unsupported records version: 4");
});

test("effect ids bind paths, type, installed state and restoration data", () => {
  const original = record();
  const ids = candidateEffects(original).map((entry) => entry.id);
  const altered = structuredClone(original);
  altered.owned[0]!.installedHash = "e".repeat(64);
  altered.mutated[0]!.beforeBlob = "f".repeat(64);
  expect(candidateEffects(altered).map((entry) => entry.id)).not.toEqual(ids);
  altered.owned[0] = { path: altered.owned[0]!.path, kind: "symlink", linkTarget: "example" };
  expect(candidateEffects(altered)[0]?.id).not.toBe(ids[0]);
  expect(candidateEffects({ ...original, name: "renamed" })).toEqual(candidateEffects(original));
});

test.each([
  [
    "missing evidence",
    (file: ReturnType<typeof readRecordFile>) => {
      file.records[0]!.evidence.pop();
    },
  ],
  [
    "duplicate evidence",
    (file: ReturnType<typeof readRecordFile>) => {
      file.records[0]!.evidence[1] = file.records[0]!.evidence[0]!;
    },
  ],
  [
    "future revision",
    (file: ReturnType<typeof readRecordFile>) => {
      file.records[0]!.revision = 2;
    },
  ],
  [
    "bad sequence",
    (file: ReturnType<typeof readRecordFile>) => {
      file.sequence = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "changed candidate",
    (file: ReturnType<typeof readRecordFile>) => {
      file.records[0]!.owned[0]!.path = "/tmp/other";
    },
  ],
] as const)("v4 rejects %s", (_name, corrupt) => {
  const file = readRecordFile({ version: 4, sequence: 1, records: [observedRecord(record(), 1, "capture")] });
  corrupt(file);
  expect(() => validateRecordFileV4(file)).toThrow();
});

test("unsupported authority and duplicate record revisions are rejected", () => {
  const file = { version: 4, sequence: 1, records: [observedRecord(record(), 1, "capture")] };
  const unsupported = {
    ...file,
    records: file.records.map((record) => ({
      ...record,
      evidence: record.evidence.map((entry) => ({ ...entry, authority: "user-approved" })),
    })),
  };
  expect(() => validateRecordFileV4(unsupported)).toThrow();
  file.records.push(observedRecord({ ...record(), id: "another" }, 1, "capture"));
  expect(() => validateRecordFileV4(file)).toThrow();
});
