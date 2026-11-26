import { CaptureBudget, DEFAULT_CAPTURE_LIMITS } from "./budget";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { MacosHeuristicCaptureBackend } from "./macos/backend";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-path-coverage-"));
  roots.push(root);
  return root;
}

test.each(["scoped", "legacy"])("%s uncertainty applies only beneath unreadable paths", async (kind) => {
  const root = fixture();
  const scope = join(root, "scope");
  for (const dir of ["locked", "readable"]) {
    mkdirSync(join(scope, dir), { recursive: true });
    writeFileSync(join(scope, dir, "old"), "old");
  }
  const probe = join(root, "probe.ts");
  writeFileSync(
    probe,
    `
    import * as fs from "node:fs";
    import { mock } from "bun:test";
    const real = { ...fs };
    const scope = process.argv[2];
    let blocked = true;
    mock.module("node:fs", () => ({ ...real,
      opendirSync: (...args) => {
        if (blocked && args[0] === scope + "/locked") throw Object.assign(new Error("unreadable subtree"), { code: "EACCES" });
        return real.opendirSync(...args);
      },
    }));
    const { scanScopedRoots, diffScopedSnapshots } = await import(${JSON.stringify(join(import.meta.dir, "macos/scoped.ts"))});
    const { snapshot } = await import(${JSON.stringify(join(import.meta.dir, "../snapshot.ts"))});
    const { diff } = await import(${JSON.stringify(join(import.meta.dir, "../diff.ts"))});
    const scan = () => ${JSON.stringify(kind)} === "scoped" ? scanScopedRoots([scope], { caseSensitive: true }) : snapshot([scope]);
    const changes = (before, after) => {
      if (${JSON.stringify(kind)} === "legacy") return diff(before, after);
      const events = diffScopedSnapshots(before, after);
      return { added: events.filter(e => e.type === "create").map(e => e.path), edited: events.filter(e => e.type === "write" || e.type === "observation").map(e => e.path), deleted: events.filter(e => e.type === "unlink").map(e => e.path) };
    };
    const before = scan();
    real.writeFileSync(scope + "/readable/new", "new");
    real.writeFileSync(scope + "/locked/new", "new");
    real.unlinkSync(scope + "/readable/old");
    blocked = false;
    const after = scan();
    const first = changes(before, after);
    if (!first.added.includes(scope + "/readable/new") || first.added.includes(scope + "/locked/new") || !first.edited.includes(scope + "/locked/new") || !first.deleted.includes(scope + "/readable/old")) throw new Error("sibling uncertainty contaminated creation/deletion: " + JSON.stringify(first));
    real.unlinkSync(scope + "/readable/new");
    real.unlinkSync(scope + "/locked/new");
    blocked = true;
    const second = changes(after, scan());
    if (!second.deleted.includes(scope + "/readable/new") || second.deleted.includes(scope + "/locked/new")) throw new Error("sibling uncertainty contaminated deletion: " + JSON.stringify(second));
  `,
  );
  const child = Bun.spawn([process.execPath, probe, scope], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});

test("many hash omissions produce a bounded report with separate content diagnostics", async () => {
  const root = fixture();
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxHashBytes: 1 });
  const session = await new MacosHeuristicCaptureBackend().start({
    pid: process.pid,
    privilege: "user",
    roots: [root],
    budget,
  });
  for (let i = 0; i < 2000; i++) writeFileSync(join(root, `file-${i}`), "content");
  const journal = await session.stop();
  expect(Buffer.byteLength(journal.partialReason ?? "")).toBeLessThan(75 * 1024);
  expect(journal.partialReason).not.toContain("scope roots could not be scanned");
  expect(journal.partialReason).toContain("omitted after 32");
  expect(journal.resources?.losses).toHaveLength(33);
});
