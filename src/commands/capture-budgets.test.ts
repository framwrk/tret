import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function fixture(extra: string, limits: Record<string, string>, capture = false, exclusive = true) {
  const home = mkdtempSync(join(tmpdir(), "tret-cli-budget-"));
  homes.push(home);
  const scope = join(home, "scope");
  mkdirSync(scope);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(`#!/bin/sh
set -e${exclusive ? "C" : ""}
printf ran > "$HOME/executed"
printf '#!/bin/sh\\nexit 0\\n' > "$HOME/scope/tool"
chmod +x "$HOME/scope/tool"
${extra}
`),
  });
  const probe = join(home, "probe.ts");
  writeFileSync(
    probe,
    `
    import { install } from ${JSON.stringify(join(import.meta.dir, "install.ts"))};
    import { enableJsonMode } from ${JSON.stringify(join(import.meta.dir, "../lib/json-output.ts"))};
    import { MacosHeuristicCaptureBackend } from ${JSON.stringify(join(import.meta.dir, "../lib/capture/macos/backend.ts"))};
    enableJsonMode();
    await install(process.argv[2], false, [], { yes: true, capture: ${capture}, ${capture ? "backend: new MacosHeuristicCaptureBackend()," : ""} allowWeakerCapture: true, roots: [process.env.HOME + "/scope"] });
  `,
  );
  async function run() {
    const child = Bun.spawn([process.execPath, probe, `http://127.0.0.1:${server.port}/install.sh`], {
      env: { ...process.env, HOME: home, ...limits },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, json: JSON.parse(stdout), stderr };
  }
  return { home, scope, run, store: new FileStorage({ homeDir: home }), stop: () => server.stop(true) };
}

test.each([false, true])("an unrelated socket does not hide a new executable (capture=%s)", async (capture) => {
  const f = await fixture("", {}, capture);
  const socket = Bun.listen({ unix: join(f.scope, "unrelated.sock"), socket: { data() {} } });
  try {
    const result = await f.run();
    expect(result.code).toBe(0);
    const record = (await f.store.loadRecords())[0]!;
    expect(record.executable).toBe(join(f.scope, "tool"));
    expect(record.owned.some((entry) => entry.path === record.executable)).toBe(true);
    expect(record.owned.some((entry) => entry.path.endsWith(".sock"))).toBe(false);
    expect(record.capture.segments?.[0]?.partialReason).toContain("unsupported");
  } finally {
    socket.stop(true);
    f.stop();
  }
});

test.each([false, true])(
  "an observed executable mutation supplies a name without removal authority (capture=%s)",
  async (capture) => {
    const f = await fixture("", {}, capture, false);
    writeFileSync(join(f.scope, "tool"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    try {
      const result = await f.run();
      expect(result.code).toBe(0);
      const record = (await f.store.loadRecords())[0]!;
      expect(record.executable).toBe(join(f.scope, "tool"));
      expect(record.owned).toEqual([]);
      expect(record.mutated).toHaveLength(1);
      expect(record.mutated[0]?.path).toBe(record.executable);
      expect(record.evidence.every((effect) => effect.authority === "none")).toBe(true);
    } finally {
      f.stop();
    }
  },
);

test("baseline budget refusal persists an honest receipt and never executes the installer", async () => {
  const f = await fixture("", { TRET_CAPTURE_MAX_NODES: "1" });
  writeFileSync(join(f.scope, "existing"), "sentinel");
  try {
    const result = await f.run();
    expect(result.code).toBe(5);
    expect(result.json).toMatchObject({ ok: false, error: { code: "capture-budget" } });
    expect(existsSync(join(f.home, "executed"))).toBe(false);
    expect(readFileSync(join(f.scope, "existing"), "utf8")).toBe("sentinel");
    expect(await f.store.loadRecords()).toEqual([]);
    expect(f.store.operations.list()[0]).toMatchObject({ stage: "partial", execution: { resources: { used: { nodes: 1 } } } });
  } finally {
    f.stop();
  }
});

test("capture close failure names the unknown observation instead of claiming no executable was added", async () => {
  const f = await fixture("", {}, true);
  const probe = join(f.home, "probe.ts");
  writeFileSync(
    probe,
    readFileSync(probe, "utf8").replace(
      "enableJsonMode();",
      `enableJsonMode();
    const start = MacosHeuristicCaptureBackend.prototype.start;
    MacosHeuristicCaptureBackend.prototype.start = async function(options) {
      const session = await start.call(this, options);
      return { ...session, stop: async () => { throw new Error("fixture close deadline"); } };
    };
  `,
    ),
  );
  try {
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe("install-capture-partial");
    expect(result.json.error.message).toContain("installer ran");
    expect(result.json.error.message).toContain("fixture close deadline");
    expect(result.json.error.message).not.toContain("added no executable");
    expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("ran");
    expect(existsSync(join(f.scope, "tool"))).toBe(true);
    expect(f.store.operations.list()[0]?.stage).toBe("partial");
  } finally {
    f.stop();
  }
});

test("post-execution scan exhaustion retains unknown evidence and exits one without retry", async () => {
  const f = await fixture('i=0; while [ "$i" -lt 20 ]; do printf data > "$HOME/scope/item-$i"; i=$((i+1)); done', {
    TRET_CAPTURE_MAX_NODES: "10",
  });
  try {
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("ran");
    expect(existsSync(join(f.scope, "item-19"))).toBe(true);
    expect(await f.store.loadRecords()).toEqual([]);
    const operation = f.store.operations.list()[0]!;
    expect(operation.stage).toBe("partial");
    expect(operation.capture?.partialReason).toContain("budget exhausted");
    expect(operation.execution?.exitCode).toBe(0);
    expect(operation.execution?.resources?.used.nodes).toBe(10);
  } finally {
    f.stop();
  }
});

test("omitted fingerprints remain visible in JSON, record and final receipt", async () => {
  const f = await fixture("", { TRET_CAPTURE_MAX_HASH_BYTES: "1" });
  try {
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(result.json.capture).toMatchObject({ completeness: "partial" });
    expect(result.json.capture.partialReason).toContain("fingerprint byte budget");
    const record = (await f.store.loadRecords())[0]!;
    expect(record.owned.find((entry) => entry.path.endsWith("/tool"))?.installedHash).toBeUndefined();
    expect(record.capture.segments?.[0]?.partialReason).toContain("fingerprint byte budget");
    const operation = f.store.operations.list()[0]!;
    expect(operation.capture?.resources).toEqual(result.json.capture.resources);
    expect(operation.capture?.partialReason).toContain("fingerprint byte budget");
    expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("ran");
  } finally {
    f.stop();
  }
});

test("trace exhaustion after the tool runs retains its prior claims and an unknown segment", async () => {
  const home = mkdtempSync(join(tmpdir(), "tret-trace-budget-"));
  homes.push(home);
  const scope = join(home, "scope");
  mkdirSync(scope);
  const tool = join(home, "tool");
  writeFileSync(
    tool,
    '#!/bin/sh\nset -eC\nprintf ran > "$HOME/executed"\ni=0; while [ "$i" -lt 20 ]; do printf data > "$HOME/scope/item-$i"; i=$((i+1)); done\n',
    { mode: 0o755 },
  );
  const store = new FileStorage({ homeDir: home });
  await store.saveRecord({
    id: "tool",
    name: "tool",
    executable: tool,
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-11-14",
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-14" }] },
    owned: [
      { path: tool, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update(readFileSync(tool)).digest("hex") },
    ],
    mutated: [],
    deleted: [],
  });
  const before = (await store.loadRecords())[0]!;
  const probe = join(home, "probe.ts");
  writeFileSync(
    probe,
    `
    import { trace } from ${JSON.stringify(join(import.meta.dir, "trace.ts"))};
    import { enableJsonMode } from ${JSON.stringify(join(import.meta.dir, "../lib/json-output.ts"))};
    import { MacosHeuristicCaptureBackend } from ${JSON.stringify(join(import.meta.dir, "../lib/capture/macos/backend.ts"))};
    enableJsonMode();
    await trace("tool", true, { allowWeakerCapture: true, roots: [process.env.HOME + "/scope"], backend: new MacosHeuristicCaptureBackend() });
  `,
  );
  const child = Bun.spawn([process.execPath, probe], {
    env: { ...process.env, HOME: home, TRET_CAPTURE_MAX_NODES: "10" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, json: JSON.parse(stdout) }).toMatchObject({
    code: 1,
    json: { ok: false, error: { code: "trace-capture-partial" } },
  });
  expect(stderr).toContain("the tool ran");
  const after = (await store.loadRecords())[0]!;
  expect(after.owned).toEqual(before.owned);
  expect(after.capture.segments?.at(-1)?.partialReason).toContain("budget exhausted");
  expect(store.operations.list()[0]?.stage).toBe("partial");
  expect(readFileSync(join(home, "executed"), "utf8")).toBe("ran");
});
