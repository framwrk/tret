import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const cli = join(import.meta.dir, "../../index.ts");
const binary = "#!/bin/sh\nexit 0\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(kind: "marked" | "owned", url = "https://example.com/fixture.sh") {
  const home = mkdtempSync(join(tmpdir(), "tret-shell-provenance-"));
  roots.push(home);
  const bin = join(home, ".local/bin/fixture");
  const profile = join(home, ".zshrc");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(home, ".tret"));
  writeFileSync(bin, binary, { mode: 0o755 });
  // This line predates the installer. A final-state marker/hash cannot establish edit provenance.
  const preexisting =
    kind === "marked" ? 'export PATH="$HOME/.local/bin:$PATH" # fixture\n' : 'export FIXTURE="$HOME/.local/bin/fixture"\n';
  const content = preexisting + "# unrelated installer change\n";
  writeFileSync(profile, content);
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
    owned: [{ path: bin, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update(binary).digest("hex") }],
    mutated: [{ path: profile, installedHash: new Bun.CryptoHasher("sha256").update(content).digest("hex") }],
    deleted: [],
  };
  const records = JSON.stringify({ version: 3, records: [record] }, null, 2);
  writeFileSync(join(home, ".tret/records.json"), records);
  return { home, bin, profile, content, records };
}

async function run(args: string[], target: ReturnType<typeof fixture>) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...process.env, HOME: target.home },
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
  expect(readFileSync(target.bin, "utf8")).toBe(binary);
  expect(readFileSync(target.profile, "utf8")).toBe(target.content);
  expect(readFileSync(join(target.home, ".tret/records.json"), "utf8")).toBe(target.records);
  expect(existsSync(join(target.home, "replacement-ran"))).toBe(false);
}

test("a deleted shell profile without a before-image stays tracked for manual reconciliation", async () => {
  const target = fixture("marked");
  const data = JSON.parse(target.records) as { version: 3; records: RecordV3[] };
  data.records[0]!.mutated = [];
  data.records[0]!.deleted = [{ path: target.profile }];
  target.records = JSON.stringify(data, null, 2);
  writeFileSync(join(target.home, ".tret/records.json"), target.records);
  rmSync(target.profile);
  const result = await run(["uninstall", "fixture", "--yes", "--force", "--json"], target);
  expect(result.code).toBe(5);
  expect(JSON.parse(result.stdout).error.code).toBe("uninstall-shell-unverified");
  expect(existsSync(target.profile)).toBe(false);
  expect(readFileSync(target.bin, "utf8")).toBe(binary);
  expect(readFileSync(join(target.home, ".tret/records.json"), "utf8")).toBe(target.records);
});

for (const kind of ["marked", "owned"] as const) {
  for (const flags of [[], ["--force"], ["--dry-run"]]) {
    test(`${kind} preexisting shell lines survive unsupported uninstall ${flags.join(" ")}`, async () => {
      const target = fixture(kind);
      const result = await run(["uninstall", "fixture", "--yes", "--json", ...flags], target);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "uninstall-shell-unverified" } });
      expectIntact(target);
    });
  }

  test(`inspect exposes unresolved ${kind} shell edits without promising cleanup`, async () => {
    const target = fixture(kind);
    const result = await run(["inspect", "fixture", "--json"], target);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout).tool;
    expect(report.incomplete).toBe(true);
    expect(report.shell.blocked).toEqual([target.profile]);
    expectIntact(target);
  });

  for (const command of ["install", "forced install", "update"]) {
    test(`${command} refuses unsupported ${kind} shell cleanup before replacement execution`, async () => {
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response('#!/bin/sh\nprintf ran > "$HOME/replacement-ran"\n'),
      });
      try {
        const url = `http://127.0.0.1:${server.port}/fixture.sh`;
        const target = fixture(kind, url);
        const args =
          command === "update" ? ["update", "fixture"] : ["install", url, ...(command === "forced install" ? ["--force"] : [])];
        const result = await run([...args, "--yes", "--json"], target);
        expect(result.code).toBe(5);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "install-shell-unverified" } });
        expectIntact(target);
      } finally {
        await server.stop(true);
      }
    });
  }
}
