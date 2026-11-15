import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import { OperationLockedError } from "../lib/operation-lease";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { resumeOperation } from "../lib/recovery";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function waitFor(test: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 6000;
  while (!(await test())) {
    if (performance.now() > deadline) throw new Error("fixture did not reach its durable prefix");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(kind: "install" | "trace", closeFails: boolean) {
  const home = mkdtempSync(join(tmpdir(), "tret-live-cli-"));
  homes.push(home);
  mkdirSync(join(home, "scope"));
  const target = join(home, "scope/tool");
  const script =
    '#!/bin/sh\nset -eC\nprintf x >> "$HOME/executed"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/scope/tool"\nchmod +x "$HOME/scope/tool"\nwhile [ ! -f "$HOME/continue" ]; do sleep 0.01; done\n';
  const program = join(home, "program");
  writeFileSync(program, script, { mode: 0o755 });
  const storage = new FileStorage({ homeDir: home });
  if (kind === "trace") {
    const record: RecordV3 = {
      id: "fixture",
      name: "fixture",
      executable: program,
      source: "install",
      url: "https://example.com",
      installedAt: "2026-11-15",
      scriptSha256: "a".repeat(64),
      privilege: "user",
      caseSensitive: true,
      capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-15" }] },
      owned: [],
      mutated: [],
      deleted: [],
    };
    await storage.saveRecord(record);
  }
  const probe = join(home, "probe.ts");
  writeFileSync(
    probe,
    `
    import { install } from ${JSON.stringify(join(import.meta.dir, "install.ts"))};
    import { trace } from ${JSON.stringify(join(import.meta.dir, "trace.ts"))};
    import { enableJsonMode } from ${JSON.stringify(join(import.meta.dir, "../lib/json-output.ts"))};
    import { existsSync } from "node:fs";
    enableJsonMode();
    const journal = () => ({ backend: 'live-fixture', completeness: 'partial', partialReason: 'live prefix', events: existsSync(${JSON.stringify(target)}) ? [{type:'create',path:${JSON.stringify(target)},after:{kind:'file',mode:493},seq:0,at:Date.now()}] : [] });
    const backend = { name:'live-fixture',completeness:'complete',start:async()=>({backend:'live-fixture',checkpoint:async()=>journal(),stop:async()=>{ ${closeFails ? "throw new Error('injected close failure');" : "return journal();"} }}) };
    ${kind === "install" ? `await install('https://example.com/fixture.sh',false,[],{yes:true,backend,roots:[process.env.HOME+'/scope'],script:{text:${JSON.stringify(script)},sha256:'a'.repeat(64)}});` : "await trace('fixture',true,{backend,roots:[process.env.HOME+'/scope']});"}
  `,
  );
  const child = Bun.spawn([process.execPath, probe], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const release = () => writeFileSync(join(home, "continue"), "go");
  return { home, target, child, stdout, stderr, storage, release };
}

test.each(["install", "trace"] as const)(
  "%s persists live events and exits one on failed close despite an observed executable",
  async (kind) => {
    const f = await fixture(kind, true);
    try {
      await waitFor(() => (f.storage.operations.list()[0]?.capture?.events.length ?? 0) > 0);
      const running = f.storage.operations.list()[0]!;
      expect(running.stage).toBe("running");
      expect(running.unknownSince).toBeDefined();
      expect(Date.parse(running.checkpointAt!)).toBeGreaterThan(Date.parse(running.unknownSince!));
      expect(running.capture?.completeness).toBe("partial");
      f.release();
      const [code, out, err] = await Promise.all([f.child.exited, f.stdout, f.stderr]);
      expect({ code, json: JSON.parse(out), err: err.includes("injected close failure") }).toMatchObject({
        code: 1,
        json: { ok: false, error: { code: `${kind}-capture-partial` } },
        err: true,
      });
      const record = (await f.storage.loadRecords())[0]!;
      expect(record.owned.map((effect) => effect.path)).toContain(f.target);
      expect(record.capture.completeness).toBe("partial");
      expect(record.evidence?.some((effect) => effect.authority !== "none")).toBe(false);
      expect(f.storage.operations.list()[0]?.stage).toBe("partial");
      expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("x");
    } finally {
      f.release();
      f.child.kill();
      await Promise.all([f.child.exited, f.stdout, f.stderr]);
    }
  },
  10000,
);

test("SIGKILL retains a durable event prefix; foreground lease survives and recovery never executes again", async () => {
  const f = await fixture("install", false);
  try {
    await waitFor(() => (f.storage.operations.list()[0]?.capture?.events.length ?? 0) > 0);
    const op = f.storage.operations.list()[0]!;
    f.child.kill("SIGKILL");
    expect(await f.child.exited).toBe(137);
    const contender = new FileStorage({ homeDir: f.home, lockTimeoutMs: 20 });
    let entered = false;
    await expect(
      contender.withOperation(async () => {
        entered = true;
      }, true),
    ).rejects.toThrow(OperationLockedError);
    expect(entered).toBe(false);
    f.release();
    await Promise.all([f.stdout, f.stderr]);
    const recovered = await resumeOperation(f.storage, op.id);
    expect(recovered.stage).toBe("partial");
    const record = (await f.storage.loadRecords())[0]!;
    expect(record.owned.map((effect) => effect.path)).toContain(f.target);
    expect(record.capture.completeness).toBe("partial");
    expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("x");
    expect(existsSync(f.target)).toBe(true);
  } finally {
    f.release();
    f.child.kill();
    await Promise.all([f.child.exited, f.stdout, f.stderr]);
  }
}, 10000);
