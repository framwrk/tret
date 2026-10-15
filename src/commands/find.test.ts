import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return (await runCliOutput(args, home, extraEnv)).code;
}

async function runCliOutput(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, ...extraEnv, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // `log` writes to the terminal, not a piped stdout, so read the combined output.
  return { code, output: `${stdout}\n${stderr}` };
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

  test("inventories an adopted folder and plans a safe uninstall of its contents", async () => {
    // Exotic on purpose: find also scans the real /opt/homebrew/bin and /usr/local/bin.
    const name = "tretfindnest";
    const home = makeDir("tret-find-home-");
    const bin = makeDir("tret-find-bin-");
    const tool = join(bin, name);
    const folder = join(home, `.${name}`);
    const state = join(folder, "state.txt");
    const edited = join(folder, "edited.txt");
    mkdirSync(join(folder, "bin"), { recursive: true });
    writeFileSync(join(folder, "bin", name), "#!/bin/sh\n");
    writeFileSync(state, "state\n");
    writeFileSync(edited, "before\n");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);

    const code = await runCli(["find", name], home, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(code).toBe(0);

    const file = JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as {
      records: StoredRecord[];
    };
    const record = file.records.find((entry) => entry.name === name);
    const byPath = new Map((record?.owned ?? []).map((entry) => [entry.path, entry]));
    expect(byPath.get(folder)?.kind).toBe("directory");
    expect(byPath.get(join(folder, "bin", name))?.installedHash).toBeDefined();
    expect(byPath.get(state)?.installedHash).toBeDefined();

    // A file edited after adoption keeps its record hash, so uninstall removes the verified paths,
    // reports the edit, and never deletes the folder around it.
    writeFileSync(edited, "user edit\n");
    const dryRun = await runCliOutput(["uninstall", name, "--dry-run"], home);
    expect(dryRun.code).toBe(0);
    expect(dryRun.output).toContain(`would remove ${state}`);
    expect(dryRun.output).toContain(`conflict ${edited} (modified)`);
    expect(dryRun.output).toContain(`conflict ${folder} (not-empty)`);
  });
});
