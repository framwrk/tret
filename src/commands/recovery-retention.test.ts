import { afterEach, expect, test } from "bun:test";
import { currentPlatform, installObservationRoots } from "../lib/platform";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { VerifiedUninstallPlanner } from "../lib/uninstall-planner";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function fixture(count = 1) {
  const home = mkdtempSync(join(tmpdir(), "tret-recovery-cli-"));
  homes.push(home);
  const store = new FileStorage({ homeDir: home });
  const ids: string[] = [];
  await store.withOperation(async () => {
    for (let i = 0; i < count; i++) {
      const op = store.operations.begin("metadata");
      ids.push(op.id);
      store.operations.checkpoint(op, { stage: "completed" });
    }
  });
  async function run(args: string[], env: Record<string, string> = {}, preload?: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        ...(preload ? ["--preload", preload] : []),
        join(import.meta.dir, "../../index.ts"),
        "--json",
        ...args,
      ],
      {
        env: { ...process.env, HOME: home, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, json: stdout.trim() ? JSON.parse(stdout) : undefined, stderr };
  }
  return { home, store, ids, run };
}

test("original inspection/discard and receipt purge need explicit decisions and preserve targets", async () => {
  const f = await fixture();
  const raw = JSON.stringify({ version: 3, records: [] });
  writeFileSync(f.store.recordsPath, raw);
  await f.store.prepareCurrentFormat();
  const records = readFileSync(f.store.recordsPath);
  const sentinel = join(f.home, "sentinel");
  writeFileSync(sentinel, "keep");
  const id = "original-v3:" + new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  expect((await f.run(["recover"])).json.originals).toContainEqual({ id, bytes: Buffer.byteLength(raw) });
  expect((await f.run(["recover", id])).json.original).toMatchObject({ verified: true, formatValid: true });
  expect((await f.run(["recover", id, "--discard"])).code).toBe(5);
  expect((await f.run(["recover", id, "--discard", "--yes"])).json.original.discarded).toBe(true);
  expect((await f.run(["recover", f.ids[0]!, "--purge", "--yes"])).code).toBe(5);
  expect((await f.run(["recover", f.ids[0]!, "--discard", "--yes"])).code).toBe(0);
  expect((await f.run(["recover", f.ids[0]!, "--purge"])).code).toBe(5);
  expect((await f.run(["recover", f.ids[0]!, "--purge", "--yes"])).json.purged).toBe(true);
  expect(readFileSync(f.store.recordsPath)).toEqual(records);
  expect(readFileSync(sentinel, "utf8")).toBe("keep");
});

test("exact recovery remains available when aggregate limits have been lowered", async () => {
  const f = await fixture(2);
  const env = { TRET_RECOVERY_MAX_BYTES: "1", TRET_RECOVERY_MAX_ENTRIES: "1" };
  expect((await f.run(["recover"], env)).code).toBe(5);
  expect((await f.run(["recover", f.ids[0]!], env)).code).toBe(0);
  expect((await f.run(["recover", f.ids[0]!, "--discard", "--yes"], env)).code).toBe(0);
  expect((await f.run(["recover", f.ids[0]!, "--purge", "--yes"], env)).code).toBe(0);
  expect(f.store.operations.get(f.ids[1]!)?.stage).toBe("completed");
});

test("malformed limits/selectors and conflicting recovery decisions refuse before mutation", async () => {
  const f = await fixture();
  const path = join(f.store.operations.directory, `${f.ids[0]}.json`);
  const bytes = readFileSync(path);
  expect((await f.run(["recover"], { TRET_RECOVERY_MAX_BYTES: "NaN" })).code).toBe(2);
  expect((await f.run(["recover", f.ids[0]!, "--discard", "--yes"], { TRET_RECOVERY_MAX_BYTES: "NaN" })).code).toBe(2);
  expect((await f.run(["recover", "original-v3:wrong", "--discard", "--yes"])).code).toBe(2);
  expect((await f.run(["recover", f.ids[0]!, "--purge", "--resume", "--yes"])).code).toBe(2);
  for (const action of ["--resume", "--discard", "--purge"]) expect((await f.run(["recover", action, "--yes"])).code).toBe(2);
  expect(readFileSync(path)).toEqual(bytes);
});

test("receipt-only inspect keeps quota and malformed-limit errors in its JSON contract", async () => {
  const f = await fixture(2);
  expect(await f.run(["inspect", "ghosttool"], { TRET_RECOVERY_MAX_ENTRIES: "1" })).toMatchObject({
    code: 5,
    json: { ok: false, error: { code: "inspect-retention" } },
  });
  expect(await f.run(["inspect", "ghosttool"], { TRET_RECOVERY_MAX_BYTES: "NaN" })).toMatchObject({
    code: 2,
    json: { ok: false, error: { code: "inspect-limits" } },
  });
});

test("unaddressable corrupt evidence is named for manual reconciliation", async () => {
  const f = await fixture();
  const path = join(f.home, ".tret/records.json.corrupt-manual");
  writeFileSync(path, "unreadable record graph");
  expect((await f.run(["recover"])).json.unresolved).toContainEqual({ path, kind: "corrupt", bytes: 23 });
});

test.each(["outcome", "native-cursor"])("recovery quota failure at %s exits one and retries without replay", async (phase) => {
  const f = await fixture();
  const file = join(f.home, "tool");
  const body = '#!/bin/sh\nprintf unexpected > "$HOME/program-ran"\n';
  writeFileSync(file, body, { mode: 0o755 });
  const record: RecordV3 = {
    id: "tool",
    name: "tool",
    executable: file,
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-11-15",
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-15" }] },
    owned: [{ path: file, kind: "file", installedHash: new Bun.CryptoHasher("sha256").update(body).digest("hex") }],
    mutated: [],
    deleted: [],
  };
  await f.store.saveRecord(record);
  expect((await f.run(["approve", "tool", file, "--remove", "--yes"])).code).toBe(0);
  let id = "";
  await f.store.withOperation(async () => {
    const current = (await f.store.loadRecords())[0]!;
    const plan = await new VerifiedUninstallPlanner().plan(current, {
      otherRecords: [current],
      getBlob: (blob) => f.store.getBlob(blob),
    });
    expect(plan.incomplete).toBe(false);
    const op = f.store.operations.begin("uninstall", [current]);
    id = op.id;
    f.store.operations.checkpoint(op, { stage: "applying", application: { plan, outcomes: [], nextAction: 0 } });
  });
  const preload = join(f.home, "quota-after-action.ts");
  writeFileSync(
    preload,
    `
    import { OperationLog } from ${JSON.stringify(join(import.meta.dir, "../lib/operation-log.ts"))};
    import { RecoveryRetention, RecoveryRetentionError } from ${JSON.stringify(join(import.meta.dir, "../lib/recovery-retention.ts"))};
    const checkpoint = OperationLog.prototype.checkpoint;
    const write = RecoveryRetention.prototype.beforeWrite;
    let armed = false;
    OperationLog.prototype.checkpoint = function(op, change) {
      if (${JSON.stringify(phase)} === "outcome"
        ? (change.application?.outcomes.length ?? 0) > (op.application?.outcomes.length ?? 0)
        : Object.values(change.application?.native ?? {}).some(receipt => receipt.step === "finished")) armed = true;
      return checkpoint.call(this, op, change);
    };
    RecoveryRetention.prototype.beforeWrite = function(...args) {
      if (armed) throw new RecoveryRetentionError("injected quota after native action");
      return write.apply(this, args);
    };
  `,
  );
  const result = await f.run(["recover", id, "--resume", "--yes"], {}, preload);
  expect(result).toMatchObject({ code: 1, json: { ok: false, error: { code: "recovery-evidence-partial" } } });
  expect(existsSync(file)).toBe(false);
  expect(f.store.operations.get(id)?.application?.native?.[0]?.step).toBe(phase === "outcome" ? "finished" : "committed");
  expect((await f.run(["recover", id, "--resume", "--yes"])).code).toBe(0);
  expect(existsSync(join(f.home, "program-ran"))).toBe(false);
  expect(await f.store.loadRecords()).toEqual([]);
});

test("a full retention store refuses before the installer executes", async () => {
  const f = await fixture();
  const path = join(f.store.operations.directory, `${f.ids[0]}.json`);
  const bytes = readFileSync(path);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response('#!/bin/sh\nprintf ran > "$HOME/executed"\n'),
  });
  try {
    const result = await f.run(
      ["install", `http://127.0.0.1:${server.port}/install.sh`, "--yes", "--allow-weaker-capture", "--no-capture"],
      { TRET_RECOVERY_MAX_ENTRIES: "1" },
    );
    expect(result).toMatchObject({ code: 5, json: { ok: false, error: { code: "recovery-retention" } } });
    expect(existsSync(join(f.home, "executed"))).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    server.stop(true);
  }
});

test("retention failure after execution keeps the last unknown checkpoint and exits one", async () => {
  const f = await fixture();
  const scope = join(f.home, "scope");
  const exclude = installObservationRoots(currentPlatform(), { home: f.home }).flatMap((root) => ["--observe-exclude", root]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        '#!/bin/sh\nset -eC\nprintf ran > "$HOME/executed"\nmkdir -p "$HOME/scope"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/scope/tool"\nchmod +x "$HOME/scope/tool"\ni=0; while [ "$i" -lt 100 ]; do printf data > "$HOME/scope/item-$i"; i=$((i+1)); done\n',
      ),
  });
  try {
    const result = await f.run(
      [
        "install",
        `http://127.0.0.1:${server.port}/install.sh`,
        "--yes",
        "--allow-weaker-capture",
        "--no-capture",
        ...exclude,
        "--observe",
        scope,
      ],
      { TRET_RECOVERY_MAX_BYTES: "8192" },
    );
    expect(result).toMatchObject({ code: 1, json: { ok: false, error: { code: "recovery-evidence-partial" } } });
    expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("ran");
    expect(existsSync(join(scope, "item-99"))).toBe(true);
    const operation = f.store.operations.list().find((op) => op.kind === "install")!;
    expect(operation.stage).toBe("running");
    expect(operation.unknownSince).toBeDefined();
    expect(await f.store.loadRecords()).toEqual([]);
  } finally {
    server.stop(true);
  }
});
