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
