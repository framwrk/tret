import { expect, test } from "bun:test";
import { formatTraceObservations, traceObservations, validTraceObservations } from "./trace-observations";
import type { NormalizedEffects } from "./normalize";
import type { RecordV3 } from "../../types";

const record: RecordV3 = {
  id: "fixture",
  name: "fixture",
  source: "install",
  url: "https://example.com",
  installedAt: "2026-11-16",
  executable: "/h/tool",
  scriptSha256: "a".repeat(64),
  privilege: "user",
  caseSensitive: true,
  owned: [],
  mutated: [],
  deleted: [],
  capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-16" }] },
};
const empty: NormalizedEffects = { owned: [], mutated: [], deleted: [], diagnostics: [] };

test("trace reporting caps entries without truncating exact names or altering the underlying effects", () => {
  const effects = {
    ...empty,
    owned: Array.from({ length: 2000 }, (_, i) => ({ path: `/h/${i}`, kind: "file" as const, installedHash: "a".repeat(64) })),
  };
  const before = JSON.stringify(effects);
  const report = traceObservations(record, effects, [record]);
  expect(report.entries).toHaveLength(32);
  expect(report.omitted).toBe(1968);
  expect(report.entries[31]?.path).toBe("/h/31");
  expect(validTraceObservations(report)).toBe(true);
  expect(JSON.stringify(effects)).toBe(before);
  expect(formatTraceObservations(report).at(-1)).toContain("1968 trace observations omitted");
});

test("trace reporting caps serialized UTF-8 bytes and counts oversized names without shortening them", () => {
  const effects = {
    ...empty,
    owned: Array.from({ length: 20 }, (_, i) => ({
      path: `/${i.toString().padStart(4, "0")}${"x".repeat(4091)}`,
      kind: "symlink" as const,
      linkTarget: "y".repeat(4096),
    })),
  };
  effects.owned.unshift({ path: "/" + "é".repeat(4095), kind: "symlink", linkTarget: "target" });
  const report = traceObservations(record, effects, [record]);
  expect(report.entries.length).toBeGreaterThan(0);
  expect(report.entries.length).toBeLessThan(20);
  expect(report.entries.every((entry) => Buffer.byteLength(entry.path) === 4096 && entry.linkTarget?.length === 4096)).toBe(
    true,
  );
  expect(report.entries.length + report.omitted).toBe(21);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(64 * 1024);
  expect(validTraceObservations(report)).toBe(true);
});

test("window observations describe deletions and symlinks without supplying restoration pins", () => {
  const report = traceObservations(
    record,
    {
      ...empty,
      owned: [{ path: "/h/link", kind: "symlink", linkTarget: "relative-target" }],
      mutated: [
        {
          path: "/h/config",
          beforeHash: "a".repeat(64),
          installedHash: "b".repeat(64),
          beforeBlob: "a".repeat(64),
          mode: 0o640,
        },
      ],
      deleted: [{ path: "/h/removed", beforeHash: "c".repeat(64), beforeBlob: "c".repeat(64), mode: 0o600 }],
    },
    [record],
  );
  expect(validTraceObservations(report)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("beforeBlob");
  expect(report.entries[2]).toEqual({
    effect: "deleted",
    path: "/h/removed",
    beforeHash: "c".repeat(64),
    mode: 0o600,
    disposition: "new-candidate",
  });
  expect(formatTraceObservations(report).join("\n")).toContain("window-before mode 640");
});

test.each([
  { effect: "future", path: "/h/p", disposition: "new-candidate" },
  { effect: "modified", path: "/h/p", disposition: "approved" },
  { effect: "modified", path: "relative", disposition: "new-candidate" },
  { effect: "modified", path: "/h/p", disposition: "already-tracked", beforeHash: "invalid" },
  { effect: "modified", path: "/h/p", disposition: "new-candidate", beforeBlob: "a".repeat(64) },
  { effect: "modified", path: "/h/p", disposition: "new-candidate", authority: "user-approved" },
  { effect: "deleted", path: "/h/p", disposition: "new-candidate", installedHash: "a".repeat(64) },
])("invalid report entries fail validation: %j", (entry) => {
  expect(validTraceObservations({ entries: [entry], omitted: 0 })).toBe(false);
});

test("historical reports may be absent; unsupported envelopes and oversized counts refuse", () => {
  expect(validTraceObservations(undefined)).toBe(false);
  expect(validTraceObservations({ entries: [], omitted: 0 })).toBe(true);
  expect(validTraceObservations({ entries: [], omitted: -1 })).toBe(false);
  expect(validTraceObservations({ entries: [], omitted: 1.5 })).toBe(false);
  expect(validTraceObservations({ entries: [], omitted: 0, authority: "user-approved" })).toBe(false);
});
