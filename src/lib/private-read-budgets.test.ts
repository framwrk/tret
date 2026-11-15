import { afterEach, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileIfExists } from "./atomic";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-private-read-budget-"));
  roots.push(root);
  return root;
}

test("private reads have a default byte ceiling even when a caller omits one", () => {
  const path = join(fixture(), "oversized");
  const fd = openSync(path, "wx", 0o600);
  try {
    ftruncateSync(fd, 65 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  expect(() => readFileIfExists(path)).toThrow("exceeds");
});

test.each(["grow", "shrink", "mode"])("a private read rejects an in-flight %s without modifying the file", async (phase) => {
  const root = fixture();
  const source = join(root, "probe.ts");
  writeFileSync(
    source,
    `
    import * as fs from "node:fs";
    import { mock } from "bun:test";
    const real = { ...fs };
    const path = process.argv[2] + "/state";
    real.writeFileSync(path, "original", { mode: 0o600 });
    let selected; let changed = false;
    mock.module("node:fs", () => ({ ...real,
      openSync: (...args) => { const fd = real.openSync(...args); if (args[0] === path) selected = fd; return fd; },
      readSync: (...args) => {
        const count = real.readSync(...args);
        if (args[0] === selected && !changed) {
          changed = true;
          if (${JSON.stringify(phase)} === "grow") real.appendFileSync(path, "grew");
          else if (${JSON.stringify(phase)} === "shrink") real.writeFileSync(path, "x");
          else real.chmodSync(path, 0o640);
        }
        return count;
      },
    }));
    const { readFileIfExists } = await import(${JSON.stringify(join(import.meta.dir, "atomic.ts"))});
    let refused = false;
    try { readFileIfExists(path, 64); } catch { refused = true; }
    if (!refused || !changed) throw new Error("a changing private file was accepted");
    const expected = ${JSON.stringify(phase)} === "grow" ? "originalgrew" : ${JSON.stringify(phase)} === "shrink" ? "x" : "original";
    if (real.readFileSync(path, "utf8") !== expected) throw new Error("reader modified data");
  `,
  );
  const child = Bun.spawn([process.execPath, source, root], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});
