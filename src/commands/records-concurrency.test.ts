import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The records lock is a storage-layer guarantee, but the failure it prevents is visible at the
// command level: two `tret` processes that read the same snapshot and save independently would
// leave the later write as the only record. This drives real concurrent commands through the
// shipped CLI so a future change cannot drop the lock and still pass the helper tests.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<number> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, ...extraEnv, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

describe("concurrent CLI record writes", () => {
  test("simultaneous find commands keep every record", async () => {
    const home = makeDir("tret-concurrent-home-");
    const bin = makeDir("tret-concurrent-bin-");
    const names = Array.from({ length: 6 }, (_, index) => `tretconcurrent${index}`);

    for (const name of names) {
      const tool = join(bin, name);
      writeFileSync(tool, `#!/bin/sh\necho ${name}\n`);
      chmodSync(tool, 0o755);
    }

    // Every command starts from the same empty store, so losing one save loses a whole record.
    const codes = await Promise.all(
      names.map((name) => runCli(["find", name], home, { PATH: `${bin}:${process.env.PATH ?? ""}` })),
    );
    expect(codes).toEqual(names.map(() => 0));

    const file = JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as {
      records: { name: string }[];
    };
    expect(file.records.map((record) => record.name).sort()).toEqual([...names].sort());
    expect(existsSync(join(home, ".tret", "records.json.lock"))).toBe(false);
  });
});
