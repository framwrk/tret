import { MemoryBaseline, RealFsInspector, captureBaseline } from "../lib/capture/linux/inspect";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { dlopen } from "bun:ffi";
import { join } from "node:path";
import { normalizeJournal } from "../lib/journal/normalize";
import { parseStraceOutput } from "../lib/capture/linux/strace";
import { reconstruct } from "../lib/capture/linux/reconstruct";
import { resumeOperation } from "../lib/recovery";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-rename-roundtrip-"));
  roots.push(home);
  const scope = join(home, "scope");
  mkdirSync(scope);
  return { home, scope, a: join(scope, "a"), b: join(scope, "b"), storage: new FileStorage({ homeDir: home }) };
}
function exchange(a: string, b: string) {
  const symbol = process.platform === "darwin" ? "renameatx_np" : "renameat2";
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    [symbol]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
  });
  try {
    const cwd = process.platform === "darwin" ? -2 : -100;
    expect(library.symbols[symbol]!(cwd, Buffer.from(a + "\0"), cwd, Buffer.from(b + "\0"), 2)).toBe(0);
  } finally {
    library.close();
  }
}
async function reconstructExchange(scope: string, a: string, b: string, baseline = new MemoryBaseline()) {
  return reconstruct({
    baseline,
    inspector: new RealFsInspector(),
    roots: [scope],
    fallbackAt: 1,
    traced: parseStraceOutput(`9 1.000001 renameat2(AT_FDCWD, "${a}", AT_FDCWD, "${b}", RENAME_EXCHANGE) = 0`, {
      roots: [scope],
    }),
  });
}
async function cli(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../index.ts"), "--json", ...args], {
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
  return { code, out, err };
}

test("native file exchange recovers two mutations without replay and restores each original only after approval", async () => {
  const { home, scope, a, b, storage } = fixture();
  writeFileSync(a, "original A");
  chmodSync(a, 0o640);
  writeFileSync(b, "original B");
  chmodSync(b, 0o600);
  const backups = { enabled: true, sizeLimitBytes: 1024 };
  const { baseline, beforeImages } = await captureBaseline([scope], { home, backups });
  exchange(a, b);
  expect(readFileSync(a, "utf8")).toBe("original B");
  expect(readFileSync(b, "utf8")).toBe("original A");
  const reconstructed = await reconstructExchange(scope, a, b, baseline);
  expect(reconstructed.diagnostics).toEqual([]);
  const sentinel = join(home, "REPLAYED"),
    executable = join(home, "must-not-run");
  writeFileSync(executable, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
  const record: RecordV3 = {
    id: "exchange",
    name: "exchange",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-11-16",
    executable,
    scriptSha256: "a".repeat(64),
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    captureSettings: { enabled: true, backups },
    capture: { backend: "pending", completeness: "partial", segments: [{ kind: "install", startedAt: "2026-11-16" }] },
  };
  let id = "";
  await storage.withOperation(async () => {
    for (const bytes of beforeImages.values()) await storage.putBlob(bytes);
    let op = storage.operations.begin("install");
    id = op.id;
    op = storage.operations.checkpoint(op, { stage: "running", checkpoint: record, pins: [...beforeImages.keys()] });
    storage.operations.checkpoint(op, {
      stage: "captured",
      capture: { backend: "linux-strace", completeness: "complete", events: reconstructed.events },
    });
  });
  await resumeOperation(storage, id);
  const recovered = (await storage.loadRecords())[0]!;
  expect(recovered.owned).toEqual([]);
  expect(recovered.deleted).toEqual([]);
  expect(recovered.mutated).toHaveLength(2);
  expect(recovered.evidence.every((entry) => entry.authority === "none" && !("approval" in entry))).toBe(true);
  expect(existsSync(sentinel)).toBe(false);
  expect((await cli(home, ["uninstall", "exchange", "--yes"])).code).toBe(5);
  expect((await cli(home, ["approve", "exchange", a, "--restore", "--yes"])).code).toBe(0);
  expect((await cli(home, ["approve", "exchange", b, "--restore", "--yes"])).code).toBe(0);
  const removed = await cli(home, ["uninstall", "exchange", "--yes"]);
  expect(removed).toMatchObject({ code: 0 });
  expect(readFileSync(a, "utf8")).toBe("original A");
  expect(statSync(a).mode & 0o777).toBe(0o640);
  expect(readFileSync(b, "utf8")).toBe("original B");
  expect(statSync(b).mode & 0o777).toBe(0o600);
  expect(existsSync(sentinel)).toBe(false);
});

test.each(["symlink", "directory"])("native %s exchanges preserve both names without invented before-images", async (kind) => {
  const { home, scope, a, b } = fixture();
  if (kind === "symlink") {
    symlinkSync("first", a);
    symlinkSync("second", b);
  } else {
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "child"), "keep me");
  }
  const { baseline } = await captureBaseline([scope], { home, backups: { enabled: false, sizeLimitBytes: 1024 } });
  exchange(a, b);
  const result = await reconstructExchange(scope, a, b, baseline);
  const effects = normalizeJournal({
    journal: { backend: "linux-strace", completeness: "partial", events: result.events },
    caseSensitive: true,
    backups: { enabled: false, sizeLimitBytes: 1024 },
  });
  expect(effects.owned).toEqual([]);
  expect(effects.deleted).toEqual([]);
  expect(effects.mutated.map((entry) => entry.path)).toEqual([a, b]);
  expect(effects.mutated.every((entry) => entry.beforeBlob === undefined)).toBe(true);
  if (kind === "directory") expect(readFileSync(join(b, "child"), "utf8")).toBe("keep me");
});

test("successful rename of hard-link aliases keeps both real names", async () => {
  const { home, scope, a, b } = fixture();
  writeFileSync(a, "shared inode");
  linkSync(a, b);
  const { baseline } = await captureBaseline([scope], { home, backups: { enabled: true, sizeLimitBytes: 1024 } });
  renameSync(a, b);
  expect(existsSync(a)).toBe(true);
  const result = await reconstruct({
    roots: [scope],
    baseline,
    inspector: new RealFsInspector(),
    fallbackAt: 1,
    traced: parseStraceOutput(`9 1.000001 rename("${a}", "${b}") = 0`, { roots: [scope] }),
  });
  expect(result.events[0]).toMatchObject({ type: "rename", semantics: "uncertain" });
  expect(readFileSync(a)).toEqual(readFileSync(b));
});
