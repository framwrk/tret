import { FakeFsInspector, MemoryBaseline } from "./inspect";
import { expect, test } from "bun:test";
import type { TracerResult } from "./raw";
import { excludePrivateState } from "../self-state";
import { normalizeJournal } from "../../journal/normalize";
import { parseStraceOutput } from "./strace";
import { reconstruct } from "./reconstruct";

const A = "a".repeat(64),
  B = "b".repeat(64);
const file = (hash: string, mode = 0o640) => ({ kind: "file" as const, hash, size: 4, mode });
function trace(flags: string, from = "/h/a", to = "/h/b", result = "0") {
  return parseStraceOutput(`9 1.000001 renameat2(AT_FDCWD, "${from}", AT_FDCWD, "${to}", ${flags}) = ${result}`, {
    roots: ["/h"],
  });
}
async function effects(traced: TracerResult, baseline = new MemoryBaseline(), inspector = new FakeFsInspector()) {
  const result = await reconstruct({ traced, baseline, inspector, roots: ["/h"], fallbackAt: 1 });
  return {
    result,
    effects: normalizeJournal({
      journal: { backend: "linux-strace", completeness: "partial", events: result.events },
      backups: { enabled: true, sizeLimitBytes: 1024 },
      availableBeforeImages: new Set([A, B]),
      caseSensitive: true,
    }),
  };
}

test.each(["RENAME_EXCHANGE", "2", "0x2"])(
  "exchange flag %s preserves two surviving names and their own before-images",
  async (flags) => {
    const baseline = new MemoryBaseline();
    baseline.setNode("/h/a", file(A));
    baseline.setNode("/h/b", file(B, 0o600));
    const { effects: e } = await effects(
      trace(flags),
      baseline,
      new FakeFsInspector([
        ["/h/a", file(B, 0o600)],
        ["/h/b", file(A)],
      ]),
    );
    expect(e.owned).toEqual([]);
    expect(e.deleted).toEqual([]);
    expect(e.mutated).toEqual([
      { path: "/h/a", beforeHash: A, beforeBlob: A, installedHash: B, mode: 0o640 },
      { path: "/h/b", beforeHash: B, beforeBlob: B, installedHash: A, mode: 0o600 },
    ]);
  },
);

test.each(["RENAME_WHITEOUT", "RENAME_WHITEOUT|RENAME_NOREPLACE", "4", "5", "0x8000", "RENAME_FUTURE"])(
  "unsupported flags %s retain uncertain effects and only sampled absence",
  async (flags) => {
    const parsed = trace(flags);
    expect(parsed.records[0]).toMatchObject({ op: "rename", semantics: "uncertain" });
    const { effects: e, result } = await effects(
      parsed,
      new MemoryBaseline([["/h/a", "file"]]),
      new FakeFsInspector([["/h/b", file(B)]]),
    );
    expect(e.owned).toEqual([]);
    expect(e.deleted).toEqual([{ path: "/h/a" }]);
    expect(e.mutated).toEqual([{ path: "/h/b", installedHash: B }]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  },
);

test("uncertain whiteout/special nodes never imply source absence", async () => {
  const { effects: e } = await effects(
    trace("RENAME_WHITEOUT"),
    new MemoryBaseline([["/h/a", "file"]]),
    new FakeFsInspector([
      ["/h/a", { kind: "unknown", reason: "special node" }],
      ["/h/b", file(B)],
    ]),
  );
  expect(e.deleted).toEqual([]);
  expect(e.owned).toEqual([]);
  expect(e.mutated.map((entry) => entry.path)).toEqual(["/h/a", "/h/b"]);
});

test("excluded audit staging retains the payload endpoint without reading staging content", async () => {
  const parsed = trace("0", "/h/audit/temp", "/h/b");
  parsed.excludedRoots = ["/h/audit"];
  const inspector = new FakeFsInspector([["/h/b", file(B)]]);
  const inspect = inspector.inspect.bind(inspector);
  inspector.inspect = async (path) => {
    expect(path).toBe("/h/b");
    return inspect(path);
  };
  const { effects: e } = await effects(parsed, new MemoryBaseline(), inspector);
  expect(e.owned).toEqual([]);
  expect(e.mutated).toEqual([{ path: "/h/b", installedHash: B }]);
});

test("private-state filtering keeps only an already-included public rename endpoint", () => {
  const event = {
    type: "rename" as const,
    seq: 0,
    at: 1,
    from: "/h/.tret/private",
    to: "/h/b",
    before: file(A),
    after: file(B),
  };
  const journal = excludePrivateState({ backend: "fixture", completeness: "complete", events: [event] }, "/h");
  expect(journal.completeness).toBe("partial");
  expect(journal.events).toEqual([expect.objectContaining({ inScope: "to", semantics: "uncertain", before: undefined })]);
  const e = normalizeJournal({ journal, caseSensitive: true, backups: { enabled: false, sizeLimitBytes: 1024 } });
  expect(e.owned).toEqual([]);
  expect(e.deleted).toEqual([]);
  expect(e.mutated).toEqual([{ path: "/h/b", installedHash: B }]);
  expect(
    excludePrivateState({ ...journal, events: [{ ...event, semantics: "uncertain", inScope: "from" }] }, "/h").events,
  ).toEqual([]);
});

test("uncertain rename diagnostics stay bounded under many distinct paths", async () => {
  const records: TracerResult["records"] = Array.from({ length: 1000 }, (_, i) => ({
    op: "rename",
    at: i,
    from: `/outside/${i}`,
    to: `/h/${i}`,
  }));
  const { result, effects: e } = await effects({ records, diagnostics: [], unsupported: [] });
  expect(result.diagnostics.length).toBeLessThanOrEqual(33);
  expect(e.diagnostics.length).toBeLessThanOrEqual(32);
  expect(e.diagnosticsOmitted).toBeGreaterThan(0);
  expect(e.owned).toEqual([]);
});

test.each(["RENAME_NOREPLACE", "1", "0x1"])(
  "successful no-replace %s proves only destination absence at that operation",
  async (flags) => {
    const { effects: e } = await effects(
      trace(flags),
      new MemoryBaseline([["/h/a", "file"]]),
      new FakeFsInspector([["/h/b", file(A)]]),
    );
    expect(e.owned).toEqual([{ path: "/h/b", kind: "file", installedHash: A }]);
    expect(e.deleted).toEqual([{ path: "/h/a" }]);
  },
);

test("failed flagged renames grant no absence or exchange evidence", () => {
  expect(trace("RENAME_NOREPLACE", "/h/a", "/h/b", "-1 EEXIST (File exists)").records).toEqual([]);
});

test.each(["0", "RENAME_EXCHANGE"])("a successful same-name rename %s is a no-op for files and directories", async (flags) => {
  for (const kind of ["file", "directory"] as const) {
    const { effects: e, result } = await effects(
      trace(flags, "/h/a", "/h/a"),
      new MemoryBaseline([["/h/a", kind]]),
      new FakeFsInspector([["/h/a", kind === "file" ? file(A) : { kind }]]),
    );
    expect(e.owned).toEqual([]);
    expect(e.mutated).toEqual([]);
    expect(e.deleted).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  }
});

test("a surviving ordinary source is not invented as a deletion (hard-link no-op or reoccupation)", async () => {
  const baseline = new MemoryBaseline();
  baseline.setNode("/h/a", file(A));
  baseline.setNode("/h/b", file(A));
  const { effects: e } = await effects(
    trace("0"),
    baseline,
    new FakeFsInspector([
      ["/h/a", file(A)],
      ["/h/b", file(A)],
    ]),
  );
  expect(e.deleted).toEqual([]);
  expect(e.owned).toEqual([]);
  expect(e.mutated.map((entry) => entry.path)).toEqual(["/h/a", "/h/b"]);
});

test.each(["0", "RENAME_EXCHANGE"])(
  "incoming rename %s retains the included endpoint without inspecting outside",
  async (flags) => {
    const parsed = trace(flags, "/outside/a", "/h/b");
    expect(parsed.records).toHaveLength(1);
    const inspector = new FakeFsInspector([["/h/b", file(B)]]);
    const inspect = inspector.inspect.bind(inspector);
    inspector.inspect = async (path) => {
      expect(path.startsWith("/h/")).toBe(true);
      return inspect(path);
    };
    const { effects: e } = await effects(parsed, new MemoryBaseline(), inspector);
    expect(e.owned).toEqual([]);
    expect(e.deleted).toEqual([]);
    expect(e.mutated).toEqual([{ path: "/h/b", installedHash: B }]);
  },
);

test("outgoing rename retains the captured included deletion; excluded endpoints never become candidates", async () => {
  const baseline = new MemoryBaseline();
  baseline.setNode("/h/a", file(A));
  for (const to of ["/outside/b", "/h/node_modules/pkg/b", "/h/.tret/operations/b"]) {
    const { effects: e } = await effects({ ...trace("0", "/h/a", to), excludedRoots: ["/h/.tret"] }, baseline);
    expect(e.owned).toEqual([]);
    expect(e.mutated).toEqual([]);
    expect(e.deleted).toEqual([{ path: "/h/a", beforeHash: A, beforeBlob: A, mode: 0o640 }]);
  }
});

test("directory exchanges downgrade known descendant creations rather than invent subtree ownership", async () => {
  const traced = trace("RENAME_EXCHANGE");
  traced.records.unshift({ op: "open", at: 0, path: "/h/a/new", created: true, exclusive: true, truncated: true });
  const baseline = new MemoryBaseline([
    ["/h/a", "directory"],
    ["/h/b", "directory"],
  ]);
  const { effects: e, result } = await effects(
    traced,
    baseline,
    new FakeFsInspector([
      ["/h/a", { kind: "directory" }],
      ["/h/b", { kind: "directory" }],
    ]),
  );
  expect(e.owned).toEqual([]);
  expect(e.deleted).toEqual([]);
  expect(e.mutated.map((entry) => entry.path)).toEqual(["/h/a", "/h/a/new", "/h/b"]);
  expect(result.diagnostics.join(" ")).toContain("directory");
});

test("exchange keeps window-start facts through writes and notices a mode-only exchange", async () => {
  const baseline = new MemoryBaseline();
  baseline.setNode("/h/a", file(A));
  baseline.setNode("/h/b", file(A, 0o600));
  const parsed = trace("RENAME_EXCHANGE");
  parsed.records.unshift({ op: "write", at: 0, path: "/h/a" });
  const { effects: e } = await effects(
    parsed,
    baseline,
    new FakeFsInspector([
      ["/h/a", file(A, 0o600)],
      ["/h/b", file(A)],
    ]),
  );
  expect(e.deleted).toEqual([]);
  expect(e.mutated).toHaveLength(2);
  expect(e.mutated[0]?.beforeHash).toBe(A);
  expect(e.mutated[0]?.mode).toBe(0o640);
});

test("no-replace cannot erase the before-image of a destination unlinked earlier in the window", async () => {
  const baseline = new MemoryBaseline();
  baseline.setNode("/h/a", file(A));
  baseline.setNode("/h/b", file(B));
  const parsed = trace("RENAME_NOREPLACE");
  parsed.records.unshift({ op: "unlink", at: 0, path: "/h/b" });
  const { effects: e } = await effects(parsed, baseline, new FakeFsInspector([["/h/b", file(A)]]));
  expect(e.owned).toEqual([]);
  expect(e.mutated).toEqual([{ path: "/h/b", beforeHash: B, beforeBlob: B, installedHash: A, mode: 0o640 }]);
});

test("exchanging two exclusively created files keeps both final fingerprints (privileged fixture shape)", async () => {
  const parsed = trace("RENAME_EXCHANGE");
  parsed.records.unshift(
    { op: "open", at: 0, path: "/h/a", created: true, exclusive: true, truncated: true },
    { op: "open", at: 0, path: "/h/b", created: true, exclusive: true, truncated: true },
  );
  const { effects: e } = await effects(
    parsed,
    new MemoryBaseline(),
    new FakeFsInspector([
      ["/h/a", file(B)],
      ["/h/b", file(A)],
    ]),
  );
  expect(e.deleted).toEqual([]);
  expect(e.mutated).toEqual([]);
  expect(e.owned).toEqual([
    { path: "/h/a", kind: "file", installedHash: B },
    { path: "/h/b", kind: "file", installedHash: A },
  ]);
});
