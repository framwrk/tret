import { FakeFsInspector, MemoryBaseline } from "./inspect";
import { expect, test } from "bun:test";
import { parseStraceOutput, splitArgs } from "./strace";
import { normalizeJournal } from "../../journal/normalize";
import { reconstruct } from "./reconstruct";

const hash = "a".repeat(64);
function parsed(how: string, returned = "3</h/tool>") {
  return parseStraceOutput(`9 1.000001 openat2(AT_FDCWD, "/h/tool", ${how}, 24) = ${returned}`, { roots: ["/h"] });
}
test("argument splitting retains nested structures and arrays as individual arguments", () => {
  expect(splitArgs('AT_FDCWD, "/h/tool", {flags=O_CREAT|O_EXCL, mode=0755, resolve=0}, 24')).toEqual([
    "AT_FDCWD",
    '"/h/tool"',
    "{flags=O_CREAT|O_EXCL, mode=0755, resolve=0}",
    "24",
  ]);
  expect(splitArgs('3, [{a=1, b=[2, 3]}], "comma,quoted"')).toHaveLength(3);
});

test.each(["O_WRONLY|O_CREAT|O_EXCL", "0xc1", "193", "0301"])(
  "openat2 %s supplies exclusive creation evidence and the struct mode",
  async (flags) => {
    const traced = parsed(`{flags=${flags}, mode=0755, resolve=0}`);
    expect(traced.records[0]).toMatchObject({ op: "open", created: true, exclusive: true, mode: 0o755 });
    const result = await reconstruct({
      traced,
      roots: ["/h"],
      baseline: new MemoryBaseline(),
      inspector: new FakeFsInspector([["/h/tool", { kind: "file", hash, size: 4 }]]),
      fallbackAt: 1,
    });
    const effects = normalizeJournal({
      journal: { backend: "linux-strace", completeness: "complete", events: result.events },
      backups: { enabled: false, sizeLimitBytes: 1024 },
      caseSensitive: true,
    });
    expect(effects.owned).toEqual([{ path: "/h/tool", kind: "file", installedHash: hash }]);
  },
);

test("openat2 ordinary create/truncate is a mutation, not exclusive creation", () => {
  expect(parsed("{flags=O_WRONLY|O_CREAT|O_TRUNC, mode=0600, resolve=0}").records[0]).toMatchObject({
    created: true,
    truncated: true,
    mode: 0o600,
  });
  expect(parsed("{flags=O_WRONLY|O_CREAT|O_TRUNC, mode=0600, resolve=0}").records[0]).not.toHaveProperty("exclusive");
});

test.each(["O_PATH|O_CREAT|O_EXCL|O_TRUNC", "0x2002c0", "O_TMPFILE|O_CREAT|O_EXCL"])(
  "non-naming open flags %s grant no creation or truncation evidence",
  (flags) => {
    for (const call of [
      `openat2(AT_FDCWD, "/h/tool", {flags=${flags}, resolve=0}, 24)`,
      `openat(AT_FDCWD, "/h/tool", ${flags}, 0600)`,
    ]) {
      const result = parseStraceOutput(`9 1.000001 ${call} = 3</h/tool>`, { roots: ["/h"] });
      if (flags.includes("O_TMPFILE")) {
        expect(result.records).toEqual([]);
        expect(result.diagnostics.join(" ")).toContain("unnamed");
      } else {
        expect(result.records[0]).toMatchObject({ created: false, truncated: false });
        expect(result.records[0]).not.toHaveProperty("exclusive");
      }
    }
  },
);

test.each([
  "0x1234",
  "{flags=O_CREAT|O_EXCL, ...}",
  "{flags=O_FUTURE|O_CREAT|O_EXCL, resolve=0}",
  ...["constructor", "toString", "__proto__", "hasOwnProperty"].map((flag) => `{flags=${flag}, resolve=0}`),
])("undecoded openat2 how %s reduces coverage without granting creation", (how) => {
  const result = parsed(how);
  expect(result.records.every((record) => record.op !== "open" || !record.exclusive)).toBe(true);
  expect(result.diagnostics.length).toBeGreaterThan(0);
});

test("in-root resolution uses the annotated result as a mutation, never the misleading absolute argument", () => {
  const result = parseStraceOutput(
    '9 1.000001 openat2(4</h/root>, "/h/decoy", {flags=O_WRONLY|O_CREAT|O_EXCL, mode=0600, resolve=RESOLVE_IN_ROOT}, 24) = 5</h/root/h/decoy>',
    { roots: ["/h"] },
  );
  expect(result.records[0]).toMatchObject({ path: "/h/root/h/decoy", created: true });
  expect(result.records[0]).not.toHaveProperty("exclusive");
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(parsed("{flags=O_CREAT|O_EXCL, resolve=RESOLVE_IN_ROOT}", "3").records).toEqual([]);
});

test("failed openat2 and read-only opens invent no creation", () => {
  expect(parsed("{flags=O_CREAT|O_EXCL, mode=0600, resolve=0}", "-1 EEXIST (File exists)").records).toEqual([]);
  expect(parsed("{flags=O_RDONLY, resolve=0}").records[0]).toMatchObject({ created: false, truncated: false });
});

test("resolution happens before lexical filtering and undecoded descriptors never inherit guessed paths", () => {
  const included = parseStraceOutput(
    '9 1.000001 openat2(4</h/root>, "/decoy", {flags=O_CREAT|O_EXCL, mode=0600, resolve=RESOLVE_IN_ROOT}, 24) = 3</h/root/decoy>',
    { roots: ["/h"] },
  );
  expect(included.records[0]).toMatchObject({ path: "/h/root/decoy", created: true });
  expect(included.records[0]).not.toHaveProperty("exclusive");
  const unknown = parseStraceOutput(
    '9 0.000001 open("/h/prior", O_RDONLY) = 3\n9 1.000001 openat2(AT_FDCWD, "/h/tool", 0x1234, 24) = 3\n9 2.000001 write(3, "x", 1) = 1',
    { roots: ["/h"] },
  );
  expect(unknown.records).toEqual([expect.objectContaining({ op: "open", path: "/h/prior" })]);
  expect(unknown.diagnostics.length).toBeGreaterThan(0);
});

test.each(["a[b", "a{b", "a(b", "a,b", "a)b", 'a"b'])("fd annotations are opaque to argument structure: %s", (name) => {
  const parent = `/h/${name}`;
  const calls = [
    [
      `openat(3<${parent}>, "x", O_WRONLY|O_CREAT|O_EXCL, 0644) = 4<${parent}/x>`,
      { op: "open", path: `${parent}/x`, exclusive: true },
    ],
    [`renameat(3<${parent}>, "x", 3<${parent}>, "y") = 0`, { op: "rename", from: `${parent}/x`, to: `${parent}/y` }],
    [`unlinkat(3<${parent}>, "x", 0) = 0`, { op: "unlink", path: `${parent}/x` }],
    [`mkdirat(3<${parent}>, "x", 0755) = 0`, { op: "mkdir", path: `${parent}/x` }],
    [`symlinkat("target", 3<${parent}>, "x") = 0`, { op: "symlink", path: `${parent}/x` }],
    [`fchmodat(3<${parent}>, "x", 0644, 0) = 0`, { op: "chmod", path: `${parent}/x`, mode: 0o644 }],
  ] as const;
  for (const [call, expected] of calls) {
    const result = parseStraceOutput(`9 1.000001 ${call}`, { roots: ["/h"] });
    expect(result.records).toEqual([expect.objectContaining(expected)]);
    expect(result.diagnostics).toEqual([]);
  }
});

test("strace's FASYNC spelling retains supported creation bits", () => {
  expect(parsed("{flags=O_WRONLY|O_CREAT|O_EXCL|FASYNC, mode=0600, resolve=0}").records[0]).toMatchObject({
    created: true,
    exclusive: true,
  });
});

test("octal truncation bits cannot be mistaken for decimal creation bits", () => {
  expect(parsed("{flags=01001, resolve=0}").records[0]).toMatchObject({ created: false, truncated: true });
  expect(parsed("{flags=01001, resolve=0}").records[0]).not.toHaveProperty("exclusive");
});
