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

test.each(["replace", "replace-twice", "churn", "symlink", "oversized", "absent"])(
  "private read handles atomic %s with bounded retries and preserves replacement bytes",
  async (phase) => {
    const root = fixture();
    const source = join(root, "atomic-read-probe.ts");
    writeFileSync(
      source,
      `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const real = { ...fs };
      const path = process.argv[2] + "/state";
      const foreign = process.argv[2] + "/foreign";
      real.writeFileSync(path, "original", {mode: 0o600});
      real.writeFileSync(foreign, "foreign bytes");
      const phase = ${JSON.stringify(phase)};
      const limit = phase === "replace-twice" ? 2 : phase === "churn" ? 4 : 1;
      let selected, mutated = false, opens = 0, changes = 0;
      let atomic;
      mock.module("node:fs", () => ({...real,
        openSync: (...args) => { const fd = real.openSync(...args); if (args[0] === path) { selected = fd; mutated = false; opens++; } return fd; },
        readSync: (...args) => {
          const count = real.readSync(...args);
          if (args[0] === selected && count > 0 && !mutated && changes < limit) {
            mutated = true; changes++;
            // Separate each injected replacement from its initial stat on coarse-clock filesystems.
            Bun.sleepSync(20);
            if (phase === "symlink") { real.unlinkSync(path); real.symlinkSync(foreign, path); }
            else if (phase === "absent") real.unlinkSync(path);
            else atomic.writeFileAtomic(path, phase === "oversized" ? new Uint8Array(65) : "new-" + changes, 0o600);
          }
          return count;
        },
      }));
      atomic = await import(${JSON.stringify(join(import.meta.dir, "atomic.ts"))});
      let bytes, failure;
      try { bytes = atomic.readFileIfExists(path, 64); } catch(error) { failure = error; }
      if (phase === "replace" || phase === "replace-twice") {
        if (failure || Buffer.from(bytes ?? []).toString() !== "new-" + limit || opens !== limit + 1)
          throw new Error("atomic replacement was not retried: " + String(failure));
      } else if (phase === "absent") {
        if (failure || bytes !== undefined || real.existsSync(path)) throw new Error("removed name returned stale bytes");
      } else {
        if (!failure) throw new Error("unsafe or continually changing private state was accepted");
        if (phase === "churn" && (opens !== 3 || changes !== 3)) throw new Error("retry count is not bounded to three reads");
        if (phase === "symlink" && (!real.lstatSync(path).isSymbolicLink() || real.readFileSync(foreign, "utf8") !== "foreign bytes")) throw new Error("foreign replacement was modified");
        if (phase === "oversized" && (real.statSync(path).size !== 65 || !failure.message.includes("exceeds"))) throw new Error("retry bypassed byte ceiling");
      }
      if (phase.startsWith("replace") || phase === "churn") {
        if (real.readFileSync(path, "utf8") !== "new-" + changes) throw new Error("reader changed replacement bytes");
      }
    `,
    );
    const child = Bun.spawn([process.execPath, source, root], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
  },
);
