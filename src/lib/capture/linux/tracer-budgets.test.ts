import { CaptureBudget, DEFAULT_CAPTURE_LIMITS } from "../budget";
import { FanotifyTracer, StraceTracer } from "./tracer";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("the audit writer cannot grow its private file beyond its byte budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-audit-budget-"));
  roots.push(root);
  const fake = join(root, "strace.sh");
  writeFileSync(
    fake,
    `#!/bin/sh
set -eu
out=""
printf '%s\\n' "$@" > "$HOME/trace-args"
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2;; *) shift;; esac
done
printf '%s' "$out" > "$HOME/trace-path"
exec 3> "$out"
i=0
while [ "$i" -lt 3000 ]; do
  printf '1000 1700000000.000001 openat(AT_FDCWD, "/scope/file", O_WRONLY|O_CREAT|O_EXCL, 0600) = 4\\n' >&3
  i=$((i+1))
done
`,
    { mode: 0o755 },
  );
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxAuditBytes: 1024 });
  const tracer = new StraceTracer({ pid: process.pid, roots: ["/scope"], budget }, { stracePath: fake, env: { HOME: root } });
  try {
    await tracer.attachProcess();
    const deadline = performance.now() + 2500;
    while ((await tracer.status()).active && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await tracer.status()).active).toBe(false);
    const args = readFileSync(join(root, "trace-args"), "utf8").split("\n");
    expect(args).toContain("raw=execve,execveat");
    expect(args).toContain("-q");
    expect(args).not.toContain("-qq");
    const calls = args.find(value => value.startsWith("trace="))!.slice(6).split(",");
    for (const call of ["chdir", "fchdir", "fork", "vfork", "clone", "clone3", "execve", "execveat", "fcntl"])
      expect(calls).toContain(call);
    const path = readFileSync(join(root, "trace-path"), "utf8");
    expect(statSync(path).size).toBeLessThanOrEqual(1024);
    await tracer.stop();
    expect(tracer.losses().join(" ")).toMatch(/audit|file size|SIGXFSZ/i);
    expect(budget.used.auditBytes).toBeLessThanOrEqual(1024);
  } finally {
    await tracer.stop();
  }
});

test.each(["stdout", "stderr"])("development helper %s overflow stops with explicit loss", async (stream) => {
  const root = mkdtempSync(join(tmpdir(), "tret-helper-budget-"));
  roots.push(root);
  const fake = join(root, "helper.sh");
  writeFileSync(fake, `#!/bin/sh\nprintf '%02048d\\n' 1 ${stream === "stderr" ? ">&2" : ""}\n`, { mode: 0o755 });
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxAuditBytes: 256 });
  const tracer = new FanotifyTracer({ pid: process.pid, roots: [root], budget }, { helperPath: fake });
  try {
    await tracer.attachProcess();
    const deadline = performance.now() + 2500;
    while ((await tracer.status()).active && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await tracer.stop();
    expect((await tracer.records()).records).toEqual([]);
    expect([...budget.losses].join(" ")).toContain("auditBytes");
    expect(budget.used.auditBytes).toBeLessThanOrEqual(256);
  } finally {
    await tracer.stop();
  }
});

test("strace live reads append new records without freezing the final result or double-counting bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tret-audit-prefix-"));
  roots.push(root);
  const fake = join(root, "strace.sh");
  writeFileSync(fake, `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
printf '10 1.0 mkdir("/scope/a", 0700) = 0\\n' >> "$out"
printf 'strace: first warning\\n' >&2
printf '%s' "$out" > "$HOME/trace-path"
while [ ! -f "$HOME/continue" ]; do sleep 0.01; done
printf '10 2.0 mkdir("/scope/b", 0700) = 0' >> "$out"
printf 'strace: later warning\\n' >&2
`, { mode: 0o755 });
  const budget = new CaptureBudget();
  const tracer = new StraceTracer({ pid: process.pid, roots: ["/scope"], budget }, { stracePath: fake, env: { HOME: root } });
  try {
    await tracer.attachProcess();
    const deadline = performance.now() + 2500;
    while (!(await Bun.file(join(root, "trace-path")).exists()) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect((await tracer.checkpoint()).records).toMatchObject([{ op: "mkdir", path: "/scope/a" }]);
    const firstBytes = budget.used.auditBytes;
    expect((await tracer.checkpoint()).records).toHaveLength(1);
    expect(budget.used.auditBytes).toBe(firstBytes);
    for (let sample = 0; sample < 40; sample++) await tracer.checkpoint();
    writeFileSync(join(root, "continue"), "go");
    while ((await tracer.status()).active && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    const path = readFileSync(join(root, "trace-path"), "utf8");
    const bytes = statSync(path).size;
    expect((await tracer.records()).records).toHaveLength(2);
    await tracer.stop();
    expect((await tracer.records()).records).toMatchObject([{ path: "/scope/a" }, { path: "/scope/b" }]);
    expect(budget.used.auditBytes).toBe(bytes);
    expect(budget.used.auditLines).toBe(2);
    expect(tracer.losses()).toEqual(["strace: first warning", "strace: later warning"]);
  } finally { writeFileSync(join(root, "continue"), "go"); await tracer.stop(); }
});
