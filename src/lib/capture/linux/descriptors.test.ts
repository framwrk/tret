import { FakeFsInspector, MemoryBaseline } from "./inspect";
import { expect, test } from "bun:test";
import { normalizeJournal } from "../../journal/normalize";
import { parseStraceOutput } from "./strace";
import { reconstruct } from "./reconstruct";

function trace(calls: string[], pid = 9) {
  return parseStraceOutput(calls.map((call, i) => `${pid} ${i + 1}.000001 ${call}`).join("\n"), {
    roots: ["/h"],
    cwd: "/h/cwd",
  });
}
test.each(["3", "3</h/dir/#123>(deleted)"])(
  "unnamed temporary writes %s cannot replace a directory's kind or invent a path",
  async (fd) => {
    const traced = trace([
      'mkdir("/h/dir", 0755) = 0',
      'openat(AT_FDCWD, "/h/dir", O_RDWR|O_TMPFILE, 0600) = 3</h/dir/#123>(deleted)',
      `write(${fd}, "x", 1) = 1`,
      `ftruncate(${fd}, 0) = 0`,
      `fchmod(${fd}, 0600) = 0`,
    ]);
    const result = await reconstruct({
      traced,
      roots: ["/h"],
      baseline: new MemoryBaseline(),
      inspector: new FakeFsInspector([["/h/dir", { kind: "directory" }]]),
      fallbackAt: 1,
    });
    const effects = normalizeJournal({
      journal: { backend: "linux-strace", completeness: "partial", events: result.events },
      caseSensitive: true,
      backups: { enabled: false, sizeLimitBytes: 1024 },
    });
    expect(effects.owned).toEqual([{ path: "/h/dir", kind: "directory" }]);
    expect(effects.mutated).toEqual([]);
    expect(effects.deleted).toEqual([]);
    expect(traced.diagnostics.join(" ")).toContain("unnamed");
  },
);

test.each(["dup(3) = 4", "dup2(3, 4) = 4", "dup3(3, 4, O_CLOEXEC) = 4"])("%s preserves unnamed descriptor identity", (call) => {
  const parsed = trace([
    'openat(AT_FDCWD, "/h/dir", O_RDWR|O_TMPFILE, 0600) = 3',
    call,
    'write(4</h/dir/#123>(deleted), "x", 1) = 1',
  ]);
  expect(parsed.records.filter((record) => record.op === "write" || record.op === "chmod")).toEqual([]);
});

test.each(["dup2", "dup3"])("failed %s leaves its destination's mapping intact", (syscall) => {
  const parsed = trace([
    'open("/h/a", O_RDWR) = 3',
    'open("/h/b", O_RDWR) = 4',
    `${syscall}(3, 4${syscall === "dup3" ? ", 0" : ""}) = -1 EINTR (Interrupted)`,
    'write(4, "x", 1) = 1',
  ]);
  expect(parsed.records.at(-1)).toMatchObject({ op: "write", path: "/h/b" });
});

test.each(["3", "3</outside/a>"])(
  "successful duplication of unknown/outside %s clears the overwritten named target",
  (source) => {
    const parsed = trace(['open("/h/b", O_RDWR) = 4', `dup2(${source}, 4) = 4`, 'write(4, "x", 1) = 1']);
    expect(parsed.records.filter((record) => record.op === "write")).toEqual([]);
  },
);

test("closing and reusing an unnamed descriptor restores ordinary named writes", () => {
  const parsed = trace([
    'openat(AT_FDCWD, "/h/dir", O_RDWR|O_TMPFILE, 0600) = 3',
    "close(3) = 0",
    'open("/h/named", O_WRONLY|O_CREAT|O_EXCL, 0600) = 3',
    "dup2(3, 4) = 4",
    'write(4, "x", 1) = 1',
  ]);
  expect(parsed.records.at(-1)).toMatchObject({ op: "write", path: "/h/named" });
});

test("O_PATH directories support relative *at calls without accepting writes on the handle", () => {
  const parsed = trace([
    'open("/h/dir", O_PATH|O_DIRECTORY) = 3',
    "dup(3) = 4",
    'openat(4, "named", O_WRONLY|O_CREAT|O_EXCL, 0600) = 5',
    'write(4</h/dir>, "x", 1) = 1',
  ]);
  expect(parsed.records.some((record) => record.op === "open" && record.path === "/h/dir/named" && record.exclusive)).toBe(
    true,
  );
  expect(parsed.records.filter((record) => record.op === "write")).toEqual([]);
});

test("an unknown numeric dirfd is not the parser's cwd", () => {
  const parsed = trace(['openat(40, "named", O_WRONLY|O_CREAT|O_EXCL, 0600) = 41']);
  expect(parsed.records).toEqual([]);
  expect(parsed.diagnostics.join(" ")).toContain("no known directory");
});

test("constrained openat2 keeps unnamed fd identity even without a returned path annotation", () => {
  const parsed = trace([
    'openat2(AT_FDCWD, "/h/dir", {flags=O_RDWR|O_TMPFILE, mode=0600, resolve=RESOLVE_BENEATH}, 24) = 3',
    "dup(3) = 4",
    'write(4</h/dir/#123>(deleted), "x", 1) = 1',
  ]);
  expect(parsed.records).toEqual([]);
  expect(parsed.diagnostics.join(" ")).toContain("openat2");
});
