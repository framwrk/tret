import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const cli = join(import.meta.dir, "../../index.ts");
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-weaker-consent-"));
  homes.push(home);
  mkdirSync(join(home, "bin"));
  const file = join(home, "bin/tool");
  writeFileSync(file, '#!/bin/sh\nprintf ran >> "$HOME/executed"\n', { mode: 0o755 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        '#!/bin/sh\nmkdir -p "$HOME/bin"\nprintf ran >> "$HOME/executed"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/bin/tool"\nchmod +x "$HOME/bin/tool"\n',
        { headers: { "content-type": "text/plain" } },
      ),
  });
  const url = `http://127.0.0.1:${server.port}/install.sh`;
  const preload = join(home, "unavailable.ts");
  writeFileSync(
    preload,
    `
    import { LinuxCaptureBackend } from ${JSON.stringify(join(import.meta.dir, "../lib/capture/linux/backend.ts"))};
    import { MacosHeuristicCaptureBackend } from ${JSON.stringify(join(import.meta.dir, "../lib/capture/macos/backend.ts"))};
    for (const Backend of [LinuxCaptureBackend, MacosHeuristicCaptureBackend]) {
      Backend.prototype.preflight = async () => { throw new Error("fixture tracer unavailable before cleanup"); };
      Backend.prototype.start = async () => { throw new Error("fixture capture cannot attach"); };
    }
  `,
  );
  const storage = new FileStorage({ homeDir: home });
  const record: RecordV3 = {
    id: "tool",
    name: "tool",
    url,
    executable: file,
    source: "install",
    installedAt: "2026-11-14",
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-14" }] },
    owned: [
      { path: file, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex") },
    ],
    mutated: [],
    deleted: [],
  };
  async function run(args: string[], inject = true) {
    const child = Bun.spawn([process.execPath, ...(inject ? ["--preload", preload] : []), cli, "--json", ...args], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  return { home, file, url, storage, record, run, stop: () => server.stop(true) };
}

for (const command of ["install", "update", "trace"]) {
  test(`--yes alone refuses known weaker ${command} before execution or prior cleanup`, async () => {
    const { home, file, url, storage, record, run, stop } = await fixture();
    try {
      await storage.saveRecord(record);
      expect((await run(["approve", "tool", file, "--remove", "--yes"], false)).code).toBe(0);
      const before = readFileSync(storage.recordsPath);
      const target = readFileSync(file);
      const args = command === "install" ? ["install", url, "--force"] : [command, "tool"];
      const result = await run([...args, "--yes"]);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "capture-consent" } });
      expect(readFileSync(storage.recordsPath)).toEqual(before);
      expect(readFileSync(file)).toEqual(target);
      expect(existsSync(join(home, "executed"))).toBe(false);
    } finally {
      await stop();
    }
  });
}

test("explicit weaker permission executes once but is not replayed on tracked update", async () => {
  const { home, file, url, storage, run, stop } = await fixture();
  try {
    rmSync(file);
    expect((await run(["install", url, "--yes", "--allow-weaker-capture"])).code).toBe(0);
    expect(readFileSync(join(home, "executed"), "utf8")).toBe("ran");
    const record = (await storage.loadRecords())[0]!;
    expect(record.captureSettings).not.toHaveProperty("allowWeakerCapture");
    expect((await run(["approve", record.id, file, "--remove", "--yes"], false)).code).toBe(0);
    const before = readFileSync(storage.recordsPath);
    const update = await run(["update", record.id, "--yes"]);
    expect(update.code).toBe(5);
    expect(JSON.parse(update.stdout)).toMatchObject({ ok: false, error: { code: "capture-consent" } });
    expect(readFileSync(storage.recordsPath)).toEqual(before);
    expect(readFileSync(join(home, "executed"), "utf8")).toBe("ran");
  } finally {
    await stop();
  }
});

test("script arguments cannot grant weaker capture permission", async () => {
  const { home, url, run, stop } = await fixture();
  try {
    const result = await run(["install", url, "--yes", "--", "--allow-weaker-capture"]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "capture-consent" } });
    expect(existsSync(join(home, "executed"))).toBe(false);
  } finally {
    await stop();
  }
});

test("disabled capture still requires separate weaker permission", async () => {
  const { home, url, run, stop } = await fixture();
  try {
    const result = await run(["install", url, "--yes", "--no-capture"]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "capture-consent" } });
    expect(existsSync(join(home, "executed"))).toBe(false);
  } finally {
    await stop();
  }
});

test("a saved disabled-capture setting is not a fresh weaker-capture decision", async () => {
  const { home, file, storage, record, run, stop } = await fixture();
  try {
    record.captureSettings = { enabled: false, backups: { enabled: false, sizeLimitBytes: 1024 } };
    await storage.saveRecord(record);
    expect((await run(["approve", "tool", file, "--remove", "--yes"], false)).code).toBe(0);
    const before = readFileSync(storage.recordsPath);
    const result = await run(["update", "tool", "--yes"]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "capture-consent" } });
    expect(readFileSync(storage.recordsPath)).toEqual(before);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(home, "executed"))).toBe(false);
  } finally {
    await stop();
  }
});

test.each([false, true])(
  "unexpected replacement attach failure retains accurate outcome and scope (weaker accepted: %s)",
  async (allowWeakerCapture) => {
    const { home, file, url, storage, record, run, stop } = await fixture();
    try {
      await storage.saveRecord(record);
      expect((await run(["approve", "tool", file, "--remove", "--yes"], false)).code).toBe(0);
      const driver = join(home, "unexpected-replacement.ts");
      writeFileSync(
        driver,
        `
      import { install } from ${JSON.stringify(join(import.meta.dir, "install.ts"))};
      import { enableJsonMode } from ${JSON.stringify(join(import.meta.dir, "../lib/json-output.ts"))};
      enableJsonMode();
      await install(${JSON.stringify(url)}, true, [], {
        yes: true, allowWeakerCapture: ${allowWeakerCapture}, replaceId: "tool", roots: [${JSON.stringify(home)}, "/opt"],
        backend: { name: "strong-fixture", completeness: "complete", start: async () => { throw new Error("unexpected attach failure"); } },
      });
    `,
      );
      const child = Bun.spawn([process.execPath, driver], {
        env: { ...process.env, HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (allowWeakerCapture) {
        expect(code).toBe(0);
        expect(JSON.parse(stdout).ok).toBe(true);
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(join(home, "executed"), "utf8")).toBe("ran");
      } else {
        expect(code).toBe(1);
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "install-capture-partial" } });
        expect(existsSync(file)).toBe(false);
        expect(existsSync(join(home, "executed"))).toBe(false);
      }
      const operation = storage.operations.list()[0]!;
      expect(operation.stage).toBe(allowWeakerCapture ? "completed" : "partial");
      if (allowWeakerCapture) expect(operation.execution?.roots).toEqual([home]);
      expect(operation.priorRecords[0]?.owned[0]?.path).toBe(file);
      expect(operation.application?.outcomes).toContainEqual({ path: file, outcome: "removed" });
    } finally {
      await stop();
    }
  },
);

test.each([false, true])("simultaneous install requests preserve unrelated data (heuristic backend %s)", async (heuristic) => {
  const home = mkdtempSync(join(tmpdir(), "tret-concurrent-observations-"));
  homes.push(home);
  const ready = join(home, "ready");
  const sentinel = join(home, "user-data.txt");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname === "/first.sh" ? "first" : "second";
      const rendezvous = name === "first"
        ? 'touch "$HOME/ready"\nfor n in 1 2 3 4 5 6 7 8 9 10; do [ ! -e "$HOME/user-data.txt" ] || break; sleep 0.1; done\n[ -f "$HOME/user-data.txt" ] || exit 42\n'
        : "";
      return new Response(`#!/bin/sh\n${rendezvous}printf '#!/bin/sh\\nexit 0\\n' > "$HOME/bin/${name}"\nchmod +x "$HOME/bin/${name}"\n`);
    },
  });
  mkdirSync(join(home, "bin"));
  const preload = join(home, "capture-preflight.ts");
  if (heuristic) writeFileSync(preload, `
    import { LinuxCaptureBackend } from ${JSON.stringify(join(import.meta.dir, "../lib/capture/linux/backend.ts"))};
    LinuxCaptureBackend.prototype.preflight = async () => { throw new Error("use the heuristic fixture backend"); };
  `);
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, ...(heuristic ? ["--preload", preload] : []), cli, "--json", ...args], {
      env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const install = (name: string) => run([
    "install", `http://127.0.0.1:${server.port}/${name}.sh`, "--yes", "--allow-weaker-capture", ...(heuristic ? [] : ["--no-capture"]),
  ]);
  try {
    const first = install("first");
    let started = false;
    for (let n = 0; n < 150; n++) {
      if (existsSync(ready)) { started = true; break; }
      await Bun.sleep(10);
    }
    const second = install("second");
    writeFileSync(sentinel, "unrelated user work");
    const results = await Promise.all([first, second]);
    expect(started).toBe(true);
    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    const records = await new FileStorage({ homeDir: home }).loadRecords();
    expect(records.map((record) => record.name).sort()).toEqual(["first", "second"]);
    expect(records.find((record) => record.name === "first")?.evidence).toContainEqual(
      expect.objectContaining({ path: sentinel, authority: "none" }),
    );
    expect((await run(["uninstall", "first", "--yes"])).code).toBe(5);
    expect((await run(["approve", "first", join(home, "bin/first"), "--remove", "--yes"])).code).toBe(0);
    expect((await run(["uninstall", "first", "--yes", "--approved-only"])).code).toBe(0);
    expect(existsSync(join(home, "bin/first"))).toBe(false);
    expect(existsSync(join(home, "bin/second"))).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("unrelated user work");
  } finally {
    await server.stop(true);
  }
});
