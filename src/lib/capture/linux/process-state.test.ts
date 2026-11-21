import { CaptureBudget, DEFAULT_CAPTURE_LIMITS } from "../budget";
import { StraceStreamParser, parseStraceOutput } from "./strace";
import { expect, test } from "bun:test";

const options = { roots: ["/h"], cwd: "/h/cwd", rootPid: 9 };
function trace(calls: [number, string][]) {
  return parseStraceOutput(calls.map(([pid, call], i) => `${pid} ${i + 1}.000001 ${call}`).join("\n"), options);
}
const create = (name: string) => `openat(AT_FDCWD, "${name}", O_WRONLY|O_CREAT|O_EXCL, 0600) = 7`;

test("successful chdir and fchdir change the observed process cwd; failed transitions do not", () => {
  const result = trace([
    [9, 'chdir("/h/one") = 0'],
    [9, create("a")],
    [9, 'chdir("/h/nope") = -1 ENOENT (missing)'],
    [9, 'open("/h/two", O_PATH|O_DIRECTORY) = 3'],
    [9, "fchdir(3) = 0"],
    [9, create("b")],
  ]);
  expect(result.records.filter((r) => r.op === "open" && r.exclusive).map((r) => r.op === "open" && r.path)).toEqual([
    "/h/one/a",
    "/h/two/b",
  ]);
});

test.each(["fork()", "vfork()", "clone(child_stack=NULL, flags=SIGCHLD)"])(
  "a completed %s observed before child activity copies fd and cwd state",
  (call) => {
    const result = trace([
      [9, 'open("/h/file", O_RDWR) = 3'],
      [9, `${call} = 10`],
      [9, 'chdir("/h/parent") = 0'],
      [10, 'write(3, "x", 1) = 1'],
      [10, create("child")],
      [10, "close(3) = 0"],
      [9, 'write(3, "p", 1) = 1'],
    ]);
    expect(result.records.filter((r) => r.op === "write").map((r) => r.pid)).toEqual([10, 9]);
    expect(result.records).toContainEqual(expect.objectContaining({ op: "open", pid: 10, path: "/h/cwd/child" }));
  },
);

test.each([
  "clone(child_stack=NULL, flags=CLONE_FILES|CLONE_FS|SIGCHLD)",
  "clone3({flags=CLONE_FILES|CLONE_FS, exit_signal=SIGCHLD}, 88)",
])("%s shares observed tables and cwd", (call) => {
  const result = trace([
    [9, 'open("/h/file", O_RDWR) = 3'],
    [9, `${call} = 10`],
    [10, "close(3) = 0"],
    [9, 'write(3, "x", 1) = 1'],
    [10, 'chdir("/h/shared") = 0'],
    [9, create("parent")],
  ]);
  expect(result.records.filter((r) => r.op === "write")).toEqual([]);
  expect(result.records).toContainEqual(expect.objectContaining({ op: "open", path: "/h/shared/parent" }));
});

test.each(["fork()", "clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD)"])(
  "exec after %s removes only child CLOEXEC mappings",
  (call) => {
    const result = trace([
      [9, 'open("/h/close", O_RDWR|O_CLOEXEC) = 3'],
      [9, 'open("/h/keep", O_RDWR) = 4'],
      [9, `${call} = 10`],
      [10, 'execve("/bin/tool", ["tool"], 0x1234) = 0'],
      [10, 'write(3, "x", 1) = 1'],
      [10, 'write(4, "y", 1) = 1'],
      [9, 'write(3, "z", 1) = 1'],
    ]);
    expect(result.records.filter((r) => r.op === "write").map((r) => ({ pid: r.pid, path: r.path }))).toEqual([
      { pid: 10, path: "/h/keep" },
      { pid: 9, path: "/h/close" },
    ]);
  },
);

test("dup clears CLOEXEC, dup3/fcntl can set it, and failed exec preserves descriptors", () => {
  const result = trace([
    [9, 'open("/h/file", O_RDWR|O_CLOEXEC) = 3'],
    [9, "dup(3) = 4"],
    [9, "dup3(3, 5, O_CLOEXEC) = 5"],
    [9, "fcntl(4, F_SETFD, FD_CLOEXEC) = 0"],
    [9, "fcntl(3, F_DUPFD, 6) = 6"],
    [9, "dup(3) = 7"],
    [9, 'execve("/missing", [], 0x0) = -1 ENOENT (missing)'],
    [9, 'write(5, "before", 6) = 6'],
    [9, 'execveat(AT_FDCWD, "/bin/tool", [], 0x0, 0) = 0'],
    [9, 'write(3, "x", 1) = 1'],
    [9, 'write(4, "x", 1) = 1'],
    [9, 'write(5, "x", 1) = 1'],
    [9, 'write(6, "after", 5) = 5'],
    [9, 'write(7, "dup-survives", 12) = 12'],
  ]);
  expect(result.records.filter((r) => r.op === "write")).toHaveLength(3);
});

test("unknown clone flags retain an unknown child state instead of copied assumptions", () => {
  const result = trace([
    [9, 'open("/h/file", O_RDWR) = 3'],
    [9, "clone3(0x1234, 88) = 10"],
    [10, 'write(3, "x", 1) = 1'],
    [10, create("child")],
  ]);
  expect(result.records.filter((r) => r.pid === 10)).toEqual([]);
  expect(result.diagnostics.length).toBeGreaterThan(0);
});

test("child observations before resumed fork completion are not overwritten by stale inherited state", () => {
  const text =
    '9 1.000001 open("/h/parent", O_RDWR) = 3\n9 2.000001 clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>\n10 3.000001 close(3) = 0\n9 4.000001 <... clone resumed>) = 10\n10 5.000001 write(3, "x", 1) = 1';
  const result = parseStraceOutput(text, options);
  expect(result.records.filter((r) => r.op === "write")).toEqual([]);
  expect(result.diagnostics.length).toBeGreaterThan(0);
});

test("process exit clears stale state without re-seeding the parser's initial cwd on pid reuse", () => {
  const result = trace([
    [9, 'open("/h/file", O_RDWR) = 3'],
    [9, "+++ exited with 0 +++"],
    [9, 'write(3, "x", 1) = 1'],
    [9, create("reused")],
  ]);
  expect(result.records.filter((r) => r.op === "write" || (r.op === "open" && r.exclusive))).toEqual([]);
});

test("process state survives live parser checkpoints", () => {
  const stream = new StraceStreamParser(options);
  stream.write(Buffer.from('9 1.000001 chdir("/h/live") = 0\n9 2.000001 fork() = 10\n'));
  stream.snapshot();
  stream.write(Buffer.from(`10 3.000001 ${create("child")}\n`));
  expect(stream.finish().records).toContainEqual(expect.objectContaining({ op: "open", path: "/h/live/child" }));
});

test.each(["0x611", "1553", "03021"])("numeric clone flags %s preserve explicit shared state", (flags) => {
  const result = trace([
    [9, 'open("/h/file", O_RDWR) = 3'],
    [9, `clone(child_stack=NULL, flags=${flags}) = 10`],
    [10, "close(3) = 0"],
    [9, 'write(3, "x", 1) = 1'],
    [10, 'chdir("/h/shared") = 0'],
    [9, create("parent")],
  ]);
  expect(result.records.filter((r) => r.op === "write")).toEqual([]);
  expect(result.records).toContainEqual(expect.objectContaining({ op: "open", path: "/h/shared/parent" }));
});

test.each(["fork() = 10", "execve(0x123, 0x456, 0x789) = 0"])(
  "%s charges copied descriptor tables before allocating",
  (call) => {
    const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxMetadataBytes: 10000 });
    const stream = new StraceStreamParser({ ...options, budget });
    stream.write(Buffer.from('9 1.0 open("/h/file", O_RDWR) = 3\n'));
    const line = `9 2.0 ${call}\n`;
    budget.consume("metadataBytes", budget.remaining("metadataBytes") - Buffer.byteLength(line.trimEnd()) - 256 - 1);
    stream.write(Buffer.from(line));
    expect(budget.fatalError?.resource).toBe("metadataBytes");
    expect(stream.finish().diagnostics.join(" ")).toContain("metadataBytes");
  },
);

test.each(["F_SETLK", "F_GETLK", "F_SETLKW", "F_SETOWN"])("%s does not falsely report descriptor coverage loss", (command) => {
  const result = trace([
    [9, 'open("/h/file", O_RDWR) = 3'],
    [9, `fcntl(3, ${command}, {l_type=F_WRLCK, l_whence=SEEK_SET, l_start=0, l_len=0}) = 0`],
    [9, 'write(3, "x", 1) = 1'],
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.records.at(-1)).toMatchObject({ op: "write", path: "/h/file" });
});

test("a child running before vfork resumes keeps inheritance unknown", () => {
  const result = parseStraceOutput(
    ["9 1.0 vfork( <unfinished ...>", `10 2.0 ${create("early-child")}`, "9 3.0 <... vfork resumed>) = 10"].join("\n"),
    options,
  );
  expect(result.records).toEqual([]);
  expect(result.diagnostics).toContain("child observed before fork completion; inherited state remains unknown");
});

test("growing relative cwd state consumes the shared metadata budget", () => {
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxMetadataBytes: 15000 });
  const stream = new StraceStreamParser({ ...options, budget });
  const calls = Array.from({ length: 20 }, (_, i) => `9 ${i + 1}.0 chdir("${"x".repeat(100)}") = 0`);
  stream.write(Buffer.from(calls.join("\n") + "\n"));
  expect(budget.fatalError?.resource).toBe("metadataBytes");
  expect(stream.finish().diagnostics.join(" ")).toContain("metadataBytes");
});


test("only an exit notice for the observed root confirms launcher exit", () => {
  const stream = new StraceStreamParser(options);
  stream.write(Buffer.from("10 1.0 +++ exited with 0 +++\n"));
  expect(stream.rootExitObserved()).toBe(false);
  stream.write(Buffer.from("9 2.0 +++ exited with 0 +++\n"));
  expect(stream.rootExitObserved()).toBe(true);
});
