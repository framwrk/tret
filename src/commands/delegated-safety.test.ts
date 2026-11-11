import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const cli = join(import.meta.dir, "../../index.ts");
const binaryBytes = "#!/bin/sh\nexit 0\n";
const payloadBytes = "user-created payload; never approved for deletion\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(kind: "package" | "managed", url = "https://example.com/fixture.sh") {
  const home = mkdtempSync(join(tmpdir(), "tret-delegated-safety-"));
  roots.push(home);
  const bin = join(home, ".local/bin/fixture");
  const root = join(home, kind === "package" ? ".bun/install/global/node_modules/@fixture/tool" : ".pi/agent/install");
  const payload = join(root, "releases/1.0.0/node_modules/user-data.txt");
  const shims = join(home, "shims");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(root, "releases/1.0.0/node_modules"), { recursive: true });
  mkdirSync(join(home, ".tret"));
  mkdirSync(shims);
  writeFileSync(bin, binaryBytes, { mode: 0o755 });
  writeFileSync(payload, payloadBytes);
  writeFileSync(
    join(root, "managed-install.json"),
    JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }),
  );
  writeFileSync(
    join(shims, "bun"),
    '#!/bin/sh\nprintf called > "$HOME/manager-called"\nrm -rf "$HOME/.bun/install/global/node_modules/@fixture/tool"\n',
    { mode: 0o755 },
  );
  const record: RecordV3 = {
    id: "fixture-id",
    name: "fixture",
    source: "install",
    url,
    installedAt: new Date(0).toISOString(),
    executable: bin,
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "fixture",
      completeness: "complete",
      segments: [{ kind: "install", startedAt: new Date(0).toISOString() }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path: bin, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update(binaryBytes).digest("hex") }],
    mutated: [],
    deleted: [],
    ...(kind === "package"
      ? { managedBy: { manager: "bun" as const, package: "@fixture/tool" } }
      : { managedInstall: { kind: "pi-managed-install", layout: "releases-v1", root } }),
  };
  const records = JSON.stringify({ version: 3, records: [record] }, null, 2);
  writeFileSync(join(home, ".tret/records.json"), records);
  return { home, bin, root, payload, shims, records };
}

async function run(args: string[], target: ReturnType<typeof fixture>) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...process.env, HOME: target.home, PATH: `${target.shims}:${process.env.PATH}` },
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

function expectIntact(target: ReturnType<typeof fixture>) {
  expect(readFileSync(target.bin, "utf8")).toBe(binaryBytes);
  expect(readFileSync(target.payload, "utf8")).toBe(payloadBytes);
  expect(readFileSync(join(target.home, ".tret/records.json"), "utf8")).toBe(target.records);
  expect(existsSync(join(target.home, "manager-called"))).toBe(false);
  expect(existsSync(join(target.home, "replacement-ran"))).toBe(false);
}

for (const kind of ["package", "managed"] as const) {
  for (const flags of [[], ["--force"], ["--dry-run"]]) {
    test(`${kind} cleanup refuses unverified delegation ${flags.join(" ")}`, async () => {
      const target = fixture(kind);
      const result = await run(["uninstall", "fixture", "--yes", "--json", ...flags], target);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "uninstall-delegated-unverified" } });
      expectIntact(target);
    });
  }

  test(`inspect exposes blocked ${kind} delegation without changing targets`, async () => {
    const target = fixture(kind);
    const result = await run(["inspect", "fixture", "--json"], target);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout).tool;
    expect(report.incomplete).toBe(true);
    expect(report.delegated.blocked).toHaveLength(1);
    expect(report.delegated.blocked[0]).toContain("manual reconciliation");
    expectIntact(target);
  });

  for (const command of ["install", "forced install", "update"]) {
    test(`${command} refuses replacement of an unverified ${kind} scope before cleanup or execution`, async () => {
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          new Response(
            '#!/bin/sh\nset -eC\nprintf ran > "$HOME/replacement-ran"\nmkdir -p "$HOME/.local/bin"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/.local/bin/fixture"\nchmod +x "$HOME/.local/bin/fixture"\n',
          ),
      });
      try {
        const target = fixture(kind, `http://127.0.0.1:${server.port}/fixture.sh`);
        const args =
          command === "update"
            ? ["update", "fixture"]
            : ["install", `http://127.0.0.1:${server.port}/fixture.sh`, ...(command === "forced install" ? ["--force"] : [])];
        const result = await run([...args, "--yes", "--json"], target);
        expect(result.code).toBe(5);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "install-delegated-unverified" } });
        expectIntact(target);
      } finally {
        await server.stop(true);
      }
    });
  }
}
