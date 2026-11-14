import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const cli = join(import.meta.dir, "../../index.ts");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-authority-safety-"));
  roots.push(home);
  const file = join(home, "bin", "fixture");
  mkdirSync(join(home, "bin"));
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const record: RecordV3 = {
    id: "fixture",
    name: "fixture",
    source: "install",
    url: "https://example.com/install.sh",
    executable: file,
    installedAt: "2026-11-11T00:00:00Z",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "linux-strace",
      completeness: "complete",
      segments: [{ kind: "install", startedAt: "2026-11-11T00:00:00Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [{ path: file, kind: "file", installedHash: hash(readFileSync(file)) }],
    mutated: [],
    deleted: [],
  };
  return { home, file, record, storage: new FileStorage({ homeDir: home }) };
}
function hash(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
async function run(home: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, cli, "--json", ...args], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("legacy complete records and force supply no cleanup authority; an approved subset retains unresolved effects", async () => {
  const { home, file, record, storage } = fixture();
  const config = join(home, "config");
  writeFileSync(config, "unrelated edit");
  record.mutated.push({ path: config });
  mkdirSync(join(home, ".tret"));
  const original = JSON.stringify({ version: 3, records: [record] });
  writeFileSync(storage.recordsPath, original);
  expect((await run(home, ["uninstall", "fixture", "--yes", "--force"])).code).toBe(5);
  expect(readFileSync(storage.recordsPath, "utf8")).toBe(original);
  expect(existsSync(file)).toBe(true);
  expect((await run(home, ["approve", "fixture", file, "--remove", "--yes"])).code).toBe(0);
  expect((await run(home, ["uninstall", "fixture", "--yes"])).code).toBe(5);
  const removed = await run(home, ["uninstall", "fixture", "--yes", "--approved-only"]);
  expect(removed.code).toBe(0);
  expect(JSON.parse(removed.stdout).scope).toBe("approved-effects");
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(config, "utf8")).toBe("unrelated edit");
  expect((await storage.loadRecords())[0]?.mutated).toEqual([{ path: config }]);
  const receipt = storage.operations.list().at(-1)!;
  expect(receipt.stage).toBe("completed");
  expect(receipt.application?.plan.retained).toContainEqual({ path: config, reason: "restoration-unavailable" });
  expect(receipt.priorRecords[0]?.owned[0]?.path).toBe(file);
});

test("explicit legacy adoption adds a current fingerprint without inventing process proof", async () => {
  const { home, file, storage } = fixture();
  mkdirSync(join(home, ".tret"));
  const original = JSON.stringify({
    version: 2,
    records: [
      {
        name: "fixture",
        source: "find",
        url: "",
        installedAt: "2026-11-11",
        executable: file,
        scriptSha256: "",
        added: [file],
        edited: [],
      },
    ],
  });
  writeFileSync(storage.recordsPath, original);
  const result = await run(home, ["approve", "fixture", file, "--remove", "--yes"]);
  expect(result.code).toBe(0);
  const record = (await storage.loadRecords())[0]!;
  expect(record.evidence[0]?.authority).toBe("user-approved");
  expect(record.evidence[0]?.attribution).toBe("observed");
  expect(record.evidence[0]?.origin).toBe("adoption");
  expect(readFileSync(`${storage.recordsPath}.legacy-v2-${hash(new TextEncoder().encode(original))}.json`, "utf8")).toBe(
    original,
  );
  expect((await run(home, ["uninstall", "fixture", "--yes"])).code).toBe(0);
  expect(existsSync(file)).toBe(false);
});

test("replacement persists its application plan before the first per-action checkpoint", async () => {
  const { home, file, record, storage } = fixture();
  await storage.saveRecord(record);
  expect((await run(home, ["approve", "fixture", file, "--remove", "--yes"])).code).toBe(0);
  const prior = (await storage.loadRecords())[0]!;
  const preload = join(home, "fail-action-checkpoint.ts");
  writeFileSync(
    preload,
    `
    import { OperationLog } from ${JSON.stringify(join(import.meta.dir, "../lib/operation-log.ts"))};
    const checkpoint = OperationLog.prototype.checkpoint;
    OperationLog.prototype.checkpoint = function(operation, change) {
      if (change.application && change.stage !== "applying") throw new Error("injected action checkpoint failure");
      return checkpoint.call(this, operation, change);
    };
  `,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response('#!/bin/sh\nprintf ran > "$HOME/replacement-ran"\n', { headers: { "content-type": "text/plain" } }),
  });
  try {
    // Use tracked update so the original record's stable id is the replacement target.
    const updated = await storage.saveRecord({ ...prior, url: `http://127.0.0.1:${server.port}/install.sh` });
    const child = Bun.spawn([process.execPath, "--preload", preload, cli, "--json", "update", "fixture", "--yes"], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("injected action checkpoint failure");
    expect((await storage.loadRecords())[0]).toEqual(updated);
    expect(existsSync(file)).toBe(true);
    const operation = storage.operations.list()[0]!;
    expect(operation.stage).toBe("applying");
    expect(operation.application?.nextAction).toBe(0);
    expect(operation.application?.outcomes).toEqual([]);
    expect(operation.application?.plan.actions).toContainEqual(expect.objectContaining({ path: file, action: "remove" }));
    expect((await run(home, ["recover", operation.id, "--resume", "--yes"])).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(home, "replacement-ran"))).toBe(false);
    expect(storage.operations.list()[0]?.reason).toContain("replacement installer was not rerun");
  } finally {
    await server.stop(true);
  }
});

test("JSON replacement reports an incomplete apply and preserves a concurrent target replacement", async () => {
  const { home, file, record, storage } = fixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response('#!/bin/sh\nprintf ran > "$HOME/replacement-ran"\n', { headers: { "content-type": "text/plain" } }),
  });
  try {
    await storage.saveRecord({ ...record, url: `http://127.0.0.1:${server.port}/install.sh` });
    expect((await run(home, ["approve", "fixture", file, "--remove", "--yes"])).code).toBe(0);
    const preload = join(home, "replace-before-apply.ts");
    writeFileSync(
      preload,
      `
      import { OperationLog } from ${JSON.stringify(join(import.meta.dir, "../lib/operation-log.ts"))};
      import { renameSync, writeFileSync } from "node:fs";
      const checkpoint = OperationLog.prototype.checkpoint;
      let substituted = false;
      OperationLog.prototype.checkpoint = function(operation, change) {
        const next = checkpoint.call(this, operation, change);
        if (!substituted && change.application && change.stage === undefined && change.application.native === undefined) {
          substituted = true;
          writeFileSync(${JSON.stringify(file + ".new")}, "later user work");
          renameSync(${JSON.stringify(file + ".new")}, ${JSON.stringify(file)});
        }
        return next;
      };
    `,
    );
    const child = Bun.spawn([process.execPath, "--preload", preload, cli, "--json", "update", "fixture", "--yes"], {
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
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "install-previous-incomplete" } });
    expect(readFileSync(file, "utf8")).toBe("later user work");
    expect((await storage.loadRecords())[0]?.owned[0]?.path).toBe(file);
    expect(existsSync(join(home, "replacement-ran"))).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("an identical-byte replacement invalidates an approval even with force", async () => {
  const { home, file, record, storage } = fixture();
  await storage.saveRecord(record);
  expect((await run(home, ["approve", "fixture", file, "--remove", "--yes"])).code).toBe(0);
  const before = readFileSync(storage.recordsPath);
  writeFileSync(join(home, "replacement"), readFileSync(file));
  renameSync(join(home, "replacement"), file);
  const result = await run(home, ["uninstall", "fixture", "--yes", "--force"]);
  expect(result.code).toBe(5);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(storage.recordsPath)).toEqual(before);
});

test("revoking a stale approval lets an explicitly narrower scope retain later user work", async () => {
  const { home, file, record, storage } = fixture();
  const other = join(home, "bin", "other");
  writeFileSync(other, "keep user work");
  record.owned.push({ path: other, kind: "file", installedHash: hash(readFileSync(other)) });
  await storage.saveRecord(record);
  for (const path of [file, other]) expect((await run(home, ["approve", "fixture", path, "--remove", "--yes"])).code).toBe(0);
  writeFileSync(join(home, "replacement"), "keep user work");
  renameSync(join(home, "replacement"), other);
  expect((await run(home, ["uninstall", "fixture", "--approved-only", "--yes"])).code).toBe(5);
  expect(existsSync(file)).toBe(true);
  expect((await run(home, ["approve", "fixture", other, "--revoke", "--yes"])).code).toBe(0);
  expect((await run(home, ["uninstall", "fixture", "--approved-only", "--yes"])).code).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(other, "utf8")).toBe("keep user work");
  expect((await storage.loadRecords())[0]?.evidence[0]?.authority).toBe("none");
});

test("hard-link aliases and protected roots cannot acquire removal approvals", async () => {
  const { home, file, record, storage } = fixture();
  record.owned.push({ path: home, kind: "directory" });
  await storage.saveRecord(record);
  linkSync(file, join(home, "alias"));
  expect((await run(home, ["approve", "fixture", file, "--remove", "--yes"])).code).toBe(5);
  expect((await run(home, ["approve", "fixture", home, "--remove", "--yes"])).code).toBe(5);
  expect(existsSync(file)).toBe(true);
  expect((await storage.loadRecords())[0]?.evidence.every((entry) => entry.authority === "none")).toBe(true);
});

test("another record's managed subtree blocks approval without requiring an exact file claim", async () => {
  const { home, file, record, storage } = fixture();
  await storage.saveRecord(record);
  await storage.saveRecord({
    ...record,
    id: "other",
    name: "other",
    executable: "",
    owned: [],
    managedInstall: { kind: "fixture", layout: "fixture", root: join(home, "bin") },
  });
  const before = readFileSync(storage.recordsPath);
  expect((await run(home, ["approve", "fixture", file, "--remove", "--yes"])).code).toBe(5);
  expect(readFileSync(storage.recordsPath)).toEqual(before);
  expect(existsSync(file)).toBe(true);
});

test("inspect rechecks the required before-image rather than advertising a corrupt blob", async () => {
  const { home, record, storage } = fixture();
  const path = join(home, "config");
  const bytes = new TextEncoder().encode("before");
  writeFileSync(path, "after");
  const blob = await storage.putBlob(bytes);
  record.mutated.push({
    path,
    installedHash: hash(new TextEncoder().encode("after")),
    beforeHash: blob.id,
    beforeBlob: blob.id,
    mode: 0o600,
  });
  await storage.saveRecord(record);
  expect((await run(home, ["approve", "fixture", path, "--restore", "--yes"])).code).toBe(0);
  writeFileSync(join(storage.objectsDir, blob.id), "bad content");
  const report = await run(home, ["inspect", "fixture"]);
  expect(report.code).toBe(0);
  expect(JSON.parse(report.stdout).tool.mutated[0].restorable).toBe(false);
  expect(JSON.parse(report.stdout).tool.actions).toContainEqual({ path, action: "conflict", reason: "missing-blob" });
});
