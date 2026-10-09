import { decodeStraceString, parseStraceOutput, splitArgs } from "./strace";
import { describe, expect, test } from "bun:test";

const T0 = 1700000000.0;

function line(pid: number, offset: number, body: string): string {
  return `${pid}  ${(T0 + offset).toFixed(6)} ${body}`;
}

describe("strace parsing: journal-relevant syscalls", () => {
  test("a plausible install sequence parses into ordered records", () => {
    const text = [
      line(1000, 1, 'mkdir("/home/.mytool", 0755) = 0'),
      line(1000, 2, 'mkdir("/home/.mytool/bin", 0755) = 0'),
      line(
        1000,
        3,
        'openat(AT_FDCWD, "/home/.mytool/bin/mytool", O_WRONLY|O_CREAT|O_TRUNC, 0755) = 3</home/.mytool/bin/mytool>',
      ),
      line(1000, 4, 'write(3</home/.mytool/bin/mytool>, "#!/bin/sh\\n", 10) = 10'),
      line(1000, 5, 'chmod("/home/.mytool/bin/mytool", 0755) = 0'),
      line(1000, 6, 'symlink("/home/.mytool/bin/mytool", "/home/.local/bin/mytool") = 0'),
      line(1000, 7, 'rename("/home/.mytool/tmp", "/home/.mytool/bin/mytool") = 0'),
      line(1000, 8, 'unlink("/home/.mytool/old") = 0'),
      line(1000, 9, 'rmdir("/home/.mytool/cache") = 0'),
    ].join("\n");

    const result = parseStraceOutput(text, { roots: ["/home"] });
    expect(result.records.map((record) => record.op)).toEqual([
      "mkdir",
      "mkdir",
      "open",
      "write",
      "chmod",
      "symlink",
      "rename",
      "unlink",
      "rmdir",
    ]);
    expect(result.records[2]).toMatchObject({
      op: "open",
      path: "/home/.mytool/bin/mytool",
      created: true,
      truncated: true,
      pid: 1000,
    });
    expect(result.records[3]).toMatchObject({ op: "write", path: "/home/.mytool/bin/mytool" });
    expect(result.records[5]).toMatchObject({
      op: "symlink",
      path: "/home/.local/bin/mytool",
      target: "/home/.mytool/bin/mytool",
    });
    expect(result.records[6]).toMatchObject({ op: "rename", from: "/home/.mytool/tmp", to: "/home/.mytool/bin/mytool" });
    expect(result.records[4]).toMatchObject({ op: "chmod", mode: 0o755 });
    expect(result.diagnostics).toEqual([]);
  });

  test("renameat, renameat2, unlinkat, mkdirat, symlinkat, fchmodat and openat2 are understood", () => {
    const text = [
      line(1, 1, 'renameat(AT_FDCWD, "/a", AT_FDCWD, "/b") = 0'),
      line(1, 2, 'renameat2(AT_FDCWD, "/c", AT_FDCWD, "/d", RENAME_NOREPLACE) = 0'),
      line(1, 3, 'unlinkat(AT_FDCWD, "/e", AT_REMOVEDIR) = 0'),
      line(1, 4, 'unlinkat(AT_FDCWD, "/f", 0) = 0'),
      line(1, 5, 'mkdirat(AT_FDCWD, "/g", 0700) = 0'),
      line(1, 6, 'symlinkat("/target", AT_FDCWD, "/link") = 0'),
      line(1, 7, 'fchmodat(AT_FDCWD, "/h", 0644, 0) = 0'),
      line(1, 8, 'openat2(AT_FDCWD, "/i", 0x7ffc, 24) = 5</i>'),
    ].join("\n");

    const result = parseStraceOutput(text);
    expect(result.records.map((record) => record.op)).toEqual([
      "rename",
      "rename",
      "rmdir",
      "unlink",
      "mkdir",
      "symlink",
      "chmod",
      "open",
    ]);
    expect(result.records[2]).toMatchObject({ op: "rmdir", path: "/e" });
    expect(result.records[5]).toMatchObject({ op: "symlink", path: "/link", target: "/target" });
    expect(result.records[7]).toMatchObject({ op: "open", path: "/i" });
  });

  test("an fd map resolves a write when strace has no -y annotation", () => {
    const text = [
      line(7, 1, 'open("/home/f", O_WRONLY|O_CREAT, 0644) = 3'),
      line(7, 2, 'write(3, "data", 4) = 4'),
      line(7, 3, "close(3) = 0"),
      line(7, 4, 'write(3, "late", 4) = 4'),
    ].join("\n");

    const result = parseStraceOutput(text);
    expect(result.records.map((record) => record.op)).toEqual(["open", "write"]);
    expect(result.records[1]).toMatchObject({ op: "write", path: "/home/f" });
  });
});

describe("strace parsing: unsupported syscalls and gaps", () => {
  test("content-changing unsupported syscalls are reported, anonymous mmap is not", () => {
    const text = [
      line(1, 1, "mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x7f0000"),
      line(1, 2, "mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, 3</home/f>, 0) = 0x7f1000"),
      line(1, 3, "sendfile(3</home/a>, 4</home/b>, NULL, 4096) = 4096"),
      line(1, 4, 'chown("/home/f", 0, 0) = 0'),
      line(1, 5, 'link("/home/a", "/home/b") = 0'),
    ].join("\n");

    const result = parseStraceOutput(text);
    expect(result.unsupported).toEqual(["chown", "link", "mmap", "sendfile"]);
    expect(result.records.filter((record) => record.op === "unsupported")).toHaveLength(4);
  });

  test("an unfinished syscall is joined with its resumed tail", () => {
    const text = [
      line(100, 1, 'openat(AT_FDCWD, "/p", O_CREAT <unfinished ...>'),
      line(100, 2, "<... openat resumed>) = 3</p>"),
    ].join("\n");

    const result = parseStraceOutput(text);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ op: "open", path: "/p", created: true });
  });

  test("an unfinished syscall that is never resumed becomes a diagnostic", () => {
    const result = parseStraceOutput(line(1, 1, 'openat(AT_FDCWD, "/p", O_CREAT <unfinished ...>'));
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual(["unfinished syscall was never resumed: openat"]);
  });

  test("a failed syscall produces no record", () => {
    const text = line(1, 1, 'openat(AT_FDCWD, "/missing", O_RDONLY) = -1 ENOENT (No such file or directory)');
    expect(parseStraceOutput(text).records).toEqual([]);
  });
});

describe("strace parsing: path resolution and scope", () => {
  test("relative paths resolve against the supplied cwd", () => {
    const text = line(1, 1, 'openat(AT_FDCWD, "sub/f", O_CREAT) = 3</home/sub/f>');
    const result = parseStraceOutput(text, { cwd: "/home" });
    expect(result.records[0]).toMatchObject({ op: "open", path: "/home/sub/f" });
    expect(result.diagnostics).toEqual([]);
  });

  test("a relative path with no cwd is dropped with a diagnostic", () => {
    const text = line(1, 1, 'openat(AT_FDCWD, "sub/f", O_CREAT) = 3</sub/f>');
    const result = parseStraceOutput(text);
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual(["relative path with no known directory: sub/f"]);
  });

  test("records outside the observe roots are dropped", () => {
    const text = [
      line(1, 1, 'mkdir("/home/keep", 0755) = 0'),
      line(1, 2, 'mkdir("/etc/settings", 0755) = 0'),
      line(1, 3, 'unlink("/home/keep2") = 0'),
    ].join("\n");
    const result = parseStraceOutput(text, { roots: ["/home"] });
    expect(result.records.map((record) => record.op)).toEqual(["mkdir", "unlink"]);
  });

  test("a dirfd-relative path resolves against the annotated directory", () => {
    const text = line(1, 1, 'openat(5</home/dir>, "child", O_CREAT) = 6</home/dir/child>');
    const result = parseStraceOutput(text);
    expect(result.records[0]).toMatchObject({ op: "open", path: "/home/dir/child" });
  });
});

describe("strace parsing: string and argument helpers", () => {
  test("decodes strace string escapes", () => {
    expect(decodeStraceString('"/a b\\"c"')).toBe('/a b"c');
    expect(decodeStraceString('"line\\nnext"')).toBe("line\nnext");
    expect(decodeStraceString('"tab\\there"')).toBe("tab\there");
    expect(decodeStraceString("/plain")).toBe("/plain");
  });

  test("splits arguments without breaking quoted commas", () => {
    expect(splitArgs('AT_FDCWD, "/a,b", O_CREAT')).toEqual(["AT_FDCWD", '"/a,b"', "O_CREAT"]);
  });
});
