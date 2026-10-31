import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../constants";

// Pipe-capture coverage for read-only informational output. `--version`, help, and the human
// `list` table must reach a piped stdout so shell pipelines can consume them, while JSON mode still
// emits exactly one document and installer-running commands keep their stdout empty for the
// pasted `tret install curl ... | bash` form.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-cli-output-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** Runs the CLI from source as a child process with stdout piped, so output is captured as a pipe. */
async function runCli(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, ...extraEnv, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function writeRecords(home: string, records: unknown[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
}

function writeRecord(home: string): void {
  const executable = join(home, ".local", "bin", "mytool");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\necho mytool\n", { mode: 0o755 });
  writeRecords(home, [
    {
      id: "rec-1",
      name: "mytool",
      source: "install",
      url: "https://example.com/install.sh",
      installedAt: "2026-10-09T00:00:00.000Z",
      executable,
      scriptSha256: "a".repeat(64),
      capture: {
        backend: "macos-heuristic",
        completeness: "heuristic",
        segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
      },
      privilege: "user",
      caseSensitive: false,
      owned: [{ path: executable, kind: "file", installedHash: "b".repeat(64) }],
      mutated: [],
      deleted: [],
    },
  ]);
}

/** Serves one raw installer over loopback; the URL needs a dotted host and a non-HTML body. */
function serve(script: string): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(script, { status: 200, headers: { "content-type": "text/plain" } }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/install.sh`,
    stop: () => server.stop(true),
  };
}

describe("informational output streams", () => {
  test("--version writes the version to a piped stdout without starting a run log", async () => {
    const home = makeHome();
    const result = await runCli(["--version"], home);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
    expect(result.stderr).toBe("");
    // The fast path answers before logging or the daily update check: no ~/.tret tree appears.
    expect(existsSync(join(home, ".tret"))).toBe(false);
  });

  test("--help and help write the usage text to a piped stdout", async () => {
    for (const args of [["--help"], ["help"]]) {
      const home = makeHome();
      const result = await runCli(args, home);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage");
      expect(result.stdout).toContain("Commands");
      expect(result.stdout).toContain("tret list");
      expect(result.stdout).toContain("print to stdout even when it is piped");
      expect(result.stderr).toBe("");
    }
  });

  test("human list writes its table to a piped stdout", async () => {
    const home = makeHome();
    writeRecord(home);
    const result = await runCli(["list"], home);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Name");
    expect(result.stdout).toContain("mytool");
    expect(result.stdout).toContain("heuristic");
    expect(result.stderr).toBe("");
  });

  test("human list writes its empty-state line to a piped stdout", async () => {
    const result = await runCli(["list"], makeHome());

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("No installs tracked.");
    expect(result.stderr).toBe("");
  });

  test("list --json emits exactly one document and no human table on stdout", async () => {
    const home = makeHome();
    writeRecord(home);
    const result = await runCli(["list", "--json"], home);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Name");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "list",
      tools: [{ name: "mytool", completeness: "heuristic" }],
    });
  });

  test("the pasted install pipeline still receives no human text on stdout", async () => {
    const home = makeHome();
    const server = serve(
      '#!/bin/bash\nset -e\nmkdir -p "$HOME/.local/bin"\nprintf \'#!/bin/sh\\necho myshellpiped\\n\' > "$HOME/.local/bin/myshellpiped"\nchmod +x "$HOME/.local/bin/myshellpiped"\n',
    );
    try {
      const result = await runCli(["install", server.url, "--no-capture", "--yes"], home);

      expect(result.code).toBe(0);
      // Any line here would have been executed by the `| bash` half of the pasted command.
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("installed myshellpiped");
    } finally {
      await server.stop();
    }
  });
});
