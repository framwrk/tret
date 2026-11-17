import { RecoveryRetentionError, recoveryLimits } from "./recovery-retention";
import { afterEach, expect, test } from "bun:test";
import { discardOriginal, inspectOriginal, purgeDiscarded } from "./recovery-originals";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { FileStorage } from "./store";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(limits: Record<string, number>) {
  const home = mkdtempSync(join(tmpdir(), "tret-retention-"));
  homes.push(home);
  const store = new FileStorage({
    homeDir: home,
    gcGraceMs: 0,
    recoveryLimits: { maxBytes: 128 * 1024 * 1024, maxEntries: 1024, maxWorkMs: 30_000, ...limits },
  });
  return { home, store };
}

test("retained receipt count refuses a new intent without discarding earlier evidence", async () => {
  const { store } = fixture({ maxEntries: 2 });
  await store.withOperation(async () => {
    for (let i = 0; i < 2; i++) {
      const operation = store.operations.begin("metadata");
      store.operations.checkpoint(operation, { stage: "completed" });
    }
    const before = store.operations.list().map((op) => readFileSync(join(store.operations.directory, `${op.id}.json`)));
    expect(() => store.operations.begin("install")).toThrow("recovery retention");
    expect(store.operations.list().map((op) => readFileSync(join(store.operations.directory, `${op.id}.json`)))).toEqual(
      before,
    );
  });
});

test("numeric recovery limits reject malformed overrides", () => {
  for (const raw of ["0", "-1", "NaN", "1e3", "1.2", "9007199254740992"])
    expect(() => recoveryLimits({ TRET_RECOVERY_MAX_BYTES: raw })).toThrow("positive safe integer");
});

test("vanished atomic staging is skipped during read-only retention enumeration", async () => {
  const { store, home } = fixture({});
  await store.withOperation(async () => {
    const op = store.operations.begin("metadata");
    store.operations.checkpoint(op, { stage: "completed" });
  });
  const stage = join(store.operations.directory, "vanished.tmp");
  writeFileSync(stage, "pending");
  const probe = join(home, "probe.ts");
  writeFileSync(
    probe,
    `
    import * as fs from "node:fs";
    import { mock } from "bun:test";
    const real = { ...fs }; let vanished = false;
    mock.module("node:fs", () => ({ ...real, lstatSync: (...args) => {
      if (args[0] === process.argv[2] && !vanished) { vanished = true; real.unlinkSync(args[0]); }
      return real.lstatSync(...args);
    } }));
    const { RecoveryRetention } = await import(${JSON.stringify(join(import.meta.dir, "recovery-retention.ts"))});
    const entries = new RecoveryRetention(process.argv[3]).inventory();
    if (!vanished || entries.length !== 1 || entries[0].kind !== "operation") throw new Error("vanished staging was retained or live evidence lost");
  `,
  );
  const child = Bun.spawn([process.execPath, probe, stage, join(home, ".tret")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});

test("a late inventory refusal preserves the started-operation classification", async () => {
  const { store } = fixture({});
  await store.withOperation(async () => {
    let op = store.operations.begin("install");
    op = store.operations.checkpoint(op, { stage: "running" });
    const bytes = readFileSync(join(store.operations.directory, `${op.id}.json`));
    const inventory = store.operations.retention.inventory.bind(store.operations.retention);
    store.operations.retention.inventory = () => {
      throw new RecoveryRetentionError("injected late inventory refusal");
    };
    try {
      let caught: unknown;
      try {
        store.operations.checkpoint(op, { stage: "partial" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RecoveryRetentionError);
      expect((caught as RecoveryRetentionError).executionMayHaveStarted).toBe(true);
      expect(readFileSync(join(store.operations.directory, `${op.id}.json`))).toEqual(bytes);
    } finally {
      store.operations.retention.inventory = inventory;
    }
  });
});

test("repeating receipt discard preserves all previously retained recovery locations", async () => {
  const { store, home } = fixture({});
  await store.withOperation(async () => {
    const paths = [join(home, "retained-stage")];
    const receipt = store.operations.recordEvidenceDiscard("explicit decision", paths);
    const discarded = store.operations.discard(receipt.id);
    expect(discarded.retainedPaths).toEqual(paths);
    expect(discarded.reason).toBe("explicit decision");
  }, true);
});

test("an interrupted receipt purge stays addressable and does not strand blob collection", async () => {
  const { store } = fixture({});
  const { NativeDirectory } = await import("./native-filesystem");
  const blob = await store.putBlob(new TextEncoder().encode("orphan"));
  const unlink = NativeDirectory.prototype.unlink;
  let id = "";
  await store.withOperation(async () => {
    const receipt = store.operations.recordEvidenceDiscard("selected metadata", []);
    id = receipt.id;
    NativeDirectory.prototype.unlink = function () {
      throw new Error("injected purge interruption");
    };
    try {
      expect(() => purgeDiscarded(store.operations, id)).toThrow("injected purge interruption");
    } finally {
      NativeDirectory.prototype.unlink = unlink;
    }
    expect(store.operations.get(id)?.stage).toBe("discarded");
    expect(purgeDiscarded(store.operations, id).purged).toBe(true);
  }, true);
  expect(await store.gcUnreferenced()).toEqual([blob.id]);
  expect(store.operations.retention.inventory().some((entry) => entry.kind === "corrupt")).toBe(false);
});

test("a large valid receipt can release evidence without dropping its retained locations", async () => {
  const { store, home } = fixture({});
  await store.withOperation(async () => {
    const operation = store.operations.begin("metadata");
    const paths = Array.from({ length: 2000 }, (_, i) => join(home, "retained-staging-location-".repeat(5) + i));
    writeFileSync(
      join(store.operations.directory, `${operation.id}.json`),
      JSON.stringify({ ...operation, version: 1, stage: "partial", retainedPaths: paths }),
    );
    const discarded = store.operations.discard(operation.id);
    expect(discarded.retainedPaths).toEqual(paths);
    expect(purgeDiscarded(store.operations, operation.id).retainedPaths).toEqual(paths);
  }, true);
});

test("exact receipt discard and purge remain available above a newly lowered aggregate limit", async () => {
  const { home, store } = fixture({});
  const ids: string[] = [];
  await store.withOperation(async () => {
    for (let i = 0; i < 2; i++) {
      const op = store.operations.begin("metadata");
      ids.push(op.id);
      store.operations.checkpoint(op, { stage: "completed" });
    }
  });
  const bounded = new FileStorage({ homeDir: home, recoveryLimits: { maxBytes: 1, maxEntries: 1, maxWorkMs: 30_000 } });
  expect(() => bounded.operations.list()).toThrow("recovery retention");
  expect(bounded.operations.get(ids[0]!)?.stage).toBe("completed");
  await bounded.withOperation(async () => {
    expect(() => purgeDiscarded(bounded.operations, ids[0]!)).toThrow("already-discarded");
    bounded.operations.discard(ids[0]!);
    expect(purgeDiscarded(bounded.operations, ids[0]!).purged).toBe(true);
    expect(bounded.operations.get(ids[1]!)?.stage).toBe("completed");
  }, true);
});

test("original discard releases only its references and never changes active records or targets", async () => {
  const { home, store } = fixture({});
  const blob = await store.putBlob(new TextEncoder().encode("before-image"));
  const retained = await store.putBlob(new TextEncoder().encode("another record's before-image"));
  const path = join(home, "config");
  writeFileSync(path, "current user content");
  const record: RecordV3 = {
    id: "tool",
    name: "tool",
    executable: "",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-11-14",
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    capture: { backend: "fixture", completeness: "partial", segments: [{ kind: "install", startedAt: "2026-11-14" }] },
    owned: [],
    mutated: [{ path, beforeBlob: blob.id }],
    deleted: [],
  };
  const raw = JSON.stringify({ version: 3, records: [record] });
  writeFileSync(store.recordsPath, raw);
  await store.prepareCurrentFormat();
  const active = (await store.loadRecords())[0]!;
  await store.removeRecord(active.id, active.revision);
  await store.saveRecord({ ...record, id: "keeper", name: "keeper", mutated: [{ path, beforeBlob: retained.id }] });
  const before = readFileSync(store.recordsPath);
  expect(await store.gcUnreferenced()).toEqual([]);
  const id = "original-v3:" + new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  expect(inspectOriginal(store.operations, id)).toMatchObject({ verified: true, formatValid: true });
  await store.withOperation(async () => {
    expect(discardOriginal(store.operations, id).discarded).toBe(true);
  }, true);
  expect(inspectOriginal(store.operations, id)).toBeUndefined();
  expect(readFileSync(store.recordsPath)).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe("current user content");
  expect(await store.gcUnreferenced()).toEqual([blob.id]);
  expect(await store.getBlob(retained.id)).toBeDefined();
  const receipt = store.operations.list()[0]!;
  await store.withOperation(async () => {
    purgeDiscarded(store.operations, receipt.id);
  }, true);
  expect(store.operations.list()).toEqual([]);
});

test.each([2, 3])("interrupted v%s original discard can resume from its verified quarantine", async (version) => {
  const { store, home } = fixture({});
  mkdirSync(join(home, ".tret"), { recursive: true });
  const raw = JSON.stringify({ version, records: [] });
  const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  const id = `original-v${version}:${hash}`;
  const stage = join(home, `.tret/records.json.corrupt-discard-original-v${version}-${hash}`);
  writeFileSync(stage, raw);
  await store.withOperation(async () => {
    expect(inspectOriginal(store.operations, id)).toMatchObject({ path: stage, verified: true, formatValid: true });
    expect(discardOriginal(store.operations, id).discarded).toBe(true);
  }, true);
  expect(existsSync(stage)).toBe(false);
});

test("mismatched, corrupt and symlinked original evidence is preserved", async () => {
  const { home, store } = fixture({});
  mkdirSync(join(home, ".tret"), { recursive: true });
  const target = join(home, "sentinel");
  writeFileSync(target, "foreign bytes");
  const id = "original-v3:" + "a".repeat(64);
  const path = join(home, ".tret", "records.json.legacy-v3-" + "a".repeat(64) + ".json");
  writeFileSync(path, "mismatch");
  await store.withOperation(async () => {
    expect(() => discardOriginal(store.operations, id)).toThrow("does not match");
  }, true);
  expect(readFileSync(path, "utf8")).toBe("mismatch");
  rmSync(path);
  symlinkSync(target, path);
  await store.withOperation(async () => {
    expect(() => discardOriginal(store.operations, id)).toThrow("regular file");
  }, true);
  expect(readFileSync(target, "utf8")).toBe("foreign bytes");
  expect(existsSync(path)).toBe(true);
});

test("migration refuses a full recovery store without changing the active source", async () => {
  const { home, store } = fixture({ maxEntries: 1 });
  mkdirSync(join(home, ".tret"), { recursive: true });
  const raw = JSON.stringify({ version: 3, records: [] });
  const retained = join(home, ".tret/records.json.legacy-v2-" + "a".repeat(64) + ".json");
  writeFileSync(retained, "older evidence");
  writeFileSync(store.recordsPath, raw);
  await expect(store.prepareCurrentFormat()).rejects.toThrow("recovery retention");
  expect(readFileSync(store.recordsPath, "utf8")).toBe(raw);
  expect(readFileSync(retained, "utf8")).toBe("older evidence");
});

test("an original substituted at quarantine is retained rather than deleted", async () => {
  const { home } = fixture({});
  const probe = join(home, "probe.ts");
  writeFileSync(
    probe,
    `
    import * as fs from "node:fs";
    import { NativeDirectory } from ${JSON.stringify(join(import.meta.dir, "native-filesystem.ts"))};
    import { FileStorage } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
    import { discardOriginal } from ${JSON.stringify(join(import.meta.dir, "recovery-originals.ts"))};
    const store = new FileStorage({ homeDir: process.env.HOME });
    const raw = JSON.stringify({ version: 3, records: [] });
    fs.mkdirSync(process.env.HOME + "/.tret", { recursive: true });
    fs.writeFileSync(store.recordsPath, raw);
    await store.prepareCurrentFormat();
    const hash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    const name = "records.json.legacy-v3-" + hash + ".json";
    const path = process.env.HOME + "/.tret/" + name;
    const move = NativeDirectory.prototype.moveExclusive;
    NativeDirectory.prototype.moveExclusive = function(source, destination, target) {
      if (source === name) { fs.renameSync(path, path + ".preserved"); fs.writeFileSync(path, "foreign replacement"); }
      return move.call(this, source, destination, target);
    };
    let refused = false;
    await store.withOperation(async () => { try { discardOriginal(store.operations, "original-v3:" + hash); } catch (error) { refused = String(error).includes("substitution retained"); } }, true);
    if (!refused || fs.readFileSync(path + ".preserved", "utf8") !== raw) throw new Error("substitution was not preserved");
    const retained = store.operations.retention.inventory().find(entry => entry.kind === "corrupt");
    if (!retained || fs.readFileSync(retained.path, "utf8") !== "foreign replacement") throw new Error("foreign bytes disappeared");
  `,
  );
  const child = Bun.spawn([process.execPath, probe], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});

test("oversized checkpoint preserves the last durable cursor and can be explicitly discarded", async () => {
  const { store } = fixture({ maxBytes: 4096 });
  await store.withOperation(async () => {
    const operation = store.operations.begin("install");
    const path = join(store.operations.directory, `${operation.id}.json`);
    const bytes = readFileSync(path);
    expect(() => store.operations.checkpoint(operation, { reason: "x".repeat(4096) })).toThrow("recovery retention");
    expect(readFileSync(path)).toEqual(bytes);
    expect(store.operations.discard(operation.id).stage).toBe("discarded");
  });
});
