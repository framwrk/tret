import { MemoryBaseline, RealFsInspector, captureBaseline } from "./inspect";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { TracerRecord } from "./raw";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { reconstruct } from "./reconstruct";
import { tmpdir } from "node:os";

const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tret-kernel-path-"));
  fixtures.push(root);
  const scope = join(root, "scope");
  await mkdir(join(scope, "left"), { recursive: true });
  await mkdir(join(scope, "right", "inner"), { recursive: true });
  await symlink(join(scope, "right", "inner"), join(scope, "left", "link"));
  return { root, scope, raw: `${scope}/left/link/../config`, target: join(scope, "right", "config") };
}

async function reconstructPaths(roots: string[], records: TracerRecord[], baseline = new MemoryBaseline()) {
  return reconstruct({
    traced: { records, diagnostics: [], unsupported: [] },
    inspector: new RealFsInspector(),
    baseline,
    roots,
    fallbackAt: 1000,
  });
}

test("real parent resolution follows a symlink before processing dot-dot", async () => {
  const { scope, raw, target } = await fixture();
  await writeFile(target, "kernel target");
  await writeFile(join(scope, "left", "config"), "lexical decoy");
  expect(await readFile(raw, "utf8")).toBe("kernel target");
  // This expected spelling has no symlink/dot-dot components; it is independent of the resolver.
  expect(await new RealFsInspector().resolve(raw)).toBe(`${await realpath(scope)}/right/config`);
});

test("reconstruction fingerprints the kernel target and retains its before-image", async () => {
  const { scope, raw, target } = await fixture();
  await writeFile(target, "before");
  await writeFile(join(scope, "left", "config"), "unrelated");
  const { baseline } = await captureBaseline([scope], {
    home: scope,
    backups: { enabled: true, sizeLimitBytes: 1024 },
  });
  await writeFile(raw, "installed");
  const result = await reconstructPaths([scope], [{ op: "write", at: 1, pid: 9, path: raw }], baseline);
  const effects = normalizeJournal({
    journal: { backend: "linux-strace", completeness: "complete", events: result.events },
    backups: { enabled: true, sizeLimitBytes: 1024 },
    caseSensitive: true,
  });
  const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  expect(effects.owned).toEqual([]);
  expect(effects.mutated).toEqual([
    expect.objectContaining({ path: target, beforeHash: hash("before"), installedHash: hash("installed") }),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(await readFile(join(scope, "left", "config"), "utf8")).toBe("unrelated");
});

test("a real symlink/dot-dot escape is diagnosed without inspecting the lexical decoy", async () => {
  const { root, scope } = await fixture();
  await mkdir(join(root, "outside", "inner"), { recursive: true });
  await symlink(join(root, "outside", "inner"), join(scope, "left", "escape"));
  await writeFile(join(root, "outside", "config"), "outside");
  await writeFile(join(scope, "left", "config"), "unrelated");
  const raw = `${scope}/left/escape/../config`;
  expect(await readFile(raw, "utf8")).toBe("outside");
  const result = await reconstructPaths([scope], [{ op: "write", at: 1, pid: 9, path: raw }]);
  expect(result.events).toEqual([]);
  expect(result.diagnostics.join(" ")).toContain(raw);
});

test("stable observe-root aliases retain the baseline's spelling and before-image", async () => {
  const { root, scope, target } = await fixture();
  await writeFile(target, "before");
  await symlink(root, join(root, "alias"));
  const observed = join(root, "alias", "scope");
  const { baseline } = await captureBaseline([observed], {
    home: scope,
    backups: { enabled: true, sizeLimitBytes: 1024 },
  });
  await writeFile(target, "after");
  const result = await reconstructPaths(
    [observed],
    [{ op: "write", at: 1, pid: 9, path: `${observed}/left/link/../config` }],
    baseline,
  );
  expect(result.events).toEqual([
    expect.objectContaining({
      type: "write",
      path: `${observed}/right/config`,
      before: expect.objectContaining({ hash: new Bun.CryptoHasher("sha256").update("before").digest("hex") }),
    }),
  ]);
});

test("resolved parents never cause the final symlink to be followed", async () => {
  const { root, scope } = await fixture();
  const payload = join(root, "payload");
  await writeFile(payload, "external payload");
  await symlink(payload, join(scope, "right", "command"));
  const result = await reconstructPaths(
    [scope],
    [{ op: "symlink", at: 1, pid: 9, path: `${scope}/left/link/../command`, target: payload }],
  );
  expect(result.events).toEqual([
    expect.objectContaining({
      type: "symlink",
      path: join(scope, "right", "command"),
      after: expect.objectContaining({ kind: "symlink", target: payload }),
    }),
  ]);
  expect(await readFile(payload, "utf8")).toBe("external payload");
});

for (const parent of ["missing/..", "not-directory/..", "loop", "dangling"]) {
  test(`unresolvable parent ${parent} retains a diagnostic instead of a lexical effect`, async () => {
    const { scope } = await fixture();
    await writeFile(join(scope, "not-directory"), "file");
    await symlink("loop", join(scope, "loop"));
    await symlink("missing-target", join(scope, "dangling"));
    const raw = `${scope}/${parent}/command`;
    const result = await reconstructPaths([scope], [{ op: "write", at: 1, pid: 9, path: raw }]);
    expect(result.events).toEqual([]);
    expect(result.diagnostics.join(" ")).toContain(raw);
  });
}

test("an ordinary absent tail retains a deleted file's baseline through an existing alias", async () => {
  const { scope, raw, target } = await fixture();
  await mkdir(target);
  await writeFile(join(target, "deleted"), "before");
  const { baseline } = await captureBaseline([scope], { home: scope });
  await rm(target, { recursive: true });
  const result = await reconstructPaths([scope], [{ op: "unlink", at: 1, pid: 9, path: `${raw}/deleted` }], baseline);
  expect(result.events).toEqual([
    expect.objectContaining({ type: "unlink", path: join(target, "deleted"), before: { kind: "file" } }),
  ]);
});
