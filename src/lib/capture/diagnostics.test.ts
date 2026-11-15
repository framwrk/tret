import { expect, test } from "bun:test";
import type { JournalEvent } from "./events";
import type { RecordV3 } from "../../types";
import { isV3Record } from "../records";
import { normalizeJournal } from "../journal/normalize";

function normalize(events: JournalEvent[]) {
  return normalizeJournal({
    journal: { backend: "fixture", completeness: "complete", events },
    backups: { enabled: false, sizeLimitBytes: 1024 },
    caseSensitive: true,
  });
}

test("normalization bounds cancellation notes and counts every omitted diagnostic", () => {
  const events: JournalEvent[] = [];
  for (let i = 0; i < 1000; i++) {
    events.push({ type: "create", path: `/scope/temp-${i}`, after: { kind: "file" }, seq: i * 2, at: 1 });
    events.push({ type: "unlink", path: `/scope/temp-${i}`, before: { kind: "file" }, seq: i * 2 + 1, at: 2 });
  }
  const effects = normalize(events);
  expect(effects.owned).toEqual([]);
  expect(effects.deleted).toEqual([]);
  expect(effects.diagnostics).toHaveLength(32);
  expect(effects.diagnosticsOmitted).toBe(968);
});

test("diagnostic byte limits preserve exact paths and account for the report envelope", () => {
  const events: JournalEvent[] = [];
  const paths = new Set<string>();
  for (let i = 0; i < 32; i++) {
    const from = "/" + String(i).padStart(4095, "x");
    const to = "/" + String(i).padStart(4095, "y");
    paths.add(from);
    paths.add(to);
    events.push({ type: "create", path: from, after: { kind: "file" }, seq: i * 2, at: 1 });
    events.push({ type: "rename", from, to, destinationBefore: null, after: { kind: "file" }, seq: i * 2 + 1, at: 2 });
  }
  const effects = normalize(events);
  const report = { entries: effects.diagnostics, omitted: effects.diagnosticsOmitted ?? 0 };
  expect(effects.owned).toHaveLength(32);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(64 * 1024);
  expect(report.entries.length).toBeGreaterThan(0);
  expect(report.entries.length).toBeLessThan(32);
  expect(report.entries.length + report.omitted).toBe(32);
  expect(report.entries.flatMap((entry) => entry.paths).every((path) => paths.has(path))).toBe(true);
});

const record: RecordV3 = {
  id: "fixture",
  name: "fixture",
  source: "install",
  url: "https://example.com",
  executable: "/scope/tool",
  scriptSha256: "a".repeat(64),
  installedAt: "2026-11-15",
  privilege: "user",
  caseSensitive: true,
  capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-15" }] },
  owned: [],
  mutated: [],
  deleted: [],
};
const note = { code: "rename", message: "a path was renamed", paths: ["/scope/a", "/scope/b"] };

test("legacy segments without normalization metadata remain valid without migration", () => {
  const before = JSON.stringify(record);
  expect(isV3Record(record)).toBe(true);
  expect(JSON.stringify(record)).toBe(before);
});

test.each([
  { entries: [note], omitted: -1 },
  { entries: [note], omitted: 1.5 },
  { entries: Array(33).fill(note), omitted: 0 },
  { entries: [{ ...note, code: "made-up" }], omitted: 0 },
  { entries: [{ ...note, message: "x".repeat(1025) }], omitted: 0 },
  { entries: [{ ...note, paths: ["relative"] }], omitted: 0 },
  { entries: [{ ...note, paths: ["/scope/a", "/scope/b", "/scope/c"] }], omitted: 0 },
  { entries: [{ ...note, paths: ["/" + "x".repeat(4096)] }], omitted: 0 },
  { entries: Array(32).fill({ ...note, paths: ["/" + "x".repeat(4095), "/" + "y".repeat(4095)] }), omitted: 0 },
])("record validation rejects malformed or oversized diagnostic report %#", (normalization) => {
  expect(
    isV3Record({ ...record, capture: { ...record.capture, segments: [{ ...record.capture.segments[0], normalization }] } }),
  ).toBe(false);
});
