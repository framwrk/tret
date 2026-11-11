import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const available of [true, false]) {
  test(`root default ignores an executable fanotify helper when strace is ${available ? "available" : "missing"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-default-tracer-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const helper = join(bin, "tret-fanotify");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, 0o755);
    const installedBin = join(root, ".tret/bin");
    mkdirSync(installedBin, { recursive: true });
    writeFileSync(join(installedBin, "tret-fanotify"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (available) {
      writeFileSync(join(bin, "strace"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "strace"), 0o755);
    }
    const script = join(root, "probe.ts");
    writeFileSync(
      script,
      `import { mock } from "bun:test";
const calls = [];
const tracer = { name: "linux-strace", losses: () => [], status: async () => ({ active: true }), stop: async () => {} };
mock.module(${JSON.stringify(join(import.meta.dir, "tracer.ts"))}, () => ({
  attachStrace: async () => { calls.push("strace"); return tracer; },
  attachFanotify: async () => { calls.push("fanotify"); return { ...tracer, name: "linux-fanotify" }; },
}));
process.getuid = () => 0;
const { LinuxCaptureBackend, defaultTracerFactory } = await import(${JSON.stringify(join(import.meta.dir, "backend.ts"))});
if (${available}) {
  const selected = await defaultTracerFactory({ pid: process.pid, roots: [] });
  if (selected.name !== "linux-strace" || JSON.stringify(calls) !== '["strace"]') throw new Error("default selected " + JSON.stringify(calls));
} else {
  const { RealFsInspector } = await import(${JSON.stringify(join(import.meta.dir, "inspect.ts"))});
  let inspected = 0;
  class Inspector extends RealFsInspector { inspect(...args) { inspected++; return super.inspect(...args); } }
  const backend = new LinuxCaptureBackend({ inspector: new Inspector() });
  try {
    await backend.start({ pid: process.pid, privilege: "root", roots: [process.argv[2]], backups: { enabled: true, sizeLimitBytes: 1024 * 1024 } });
    throw new Error("expected preflight failure");
  } catch (error) { if (!error.message.includes("strace")) throw error; }
  if (inspected !== 0 || calls.length !== 0) throw new Error("read baseline or selected helper before refusing missing strace");
}
`,
    );
    const child = Bun.spawn([process.execPath, script, root], {
      env: { ...process.env, HOME: root, PATH: bin, TRET_FANOTIFY: helper },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(4000),
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  });
}
