import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

type StoredRecord = {
  name: string;
  source: string;
  capture: { completeness: string; segments: { kind: string }[] };
  owned: { path: string; kind: string; installedHash?: string }[];
};

describe("find", () => {
  test("adopts an installed command as a fingerprinted v3 record", async () => {
    const home = makeDir("tret-find-home-");
    const bin = makeDir("tret-find-bin-");
    const tool = join(bin, "adoptme");
    writeFileSync(tool, "#!/bin/sh\necho adoptme\n");
    chmodSync(tool, 0o755);

    const code = await runCli(["find", "adoptme"], home, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(code).toBe(0);

    const file = JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as {
      version: number;
      records: StoredRecord[];
    };
    expect(file.version).toBe(3);
    const record = file.records.find((entry) => entry.name === "adoptme");
    expect(record).toBeDefined();
    expect(record?.source).toBe("find");
    expect(record?.capture.completeness).toBe("heuristic");
    expect(record?.capture.segments[0]?.kind).toBe("find");
    const owned = record?.owned.find((entry) => entry.path === tool);
    expect(owned?.kind).toBe("file");
    expect(owned?.installedHash).toBeDefined();
  });
});
