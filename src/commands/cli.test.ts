import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { VERSION } from "../constants";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Cross-command cover for the documented global flag positions and selector handling. `--json` is
// global, so it must work before or after the command; after `--` it belongs to the installer. A
// bare `update --json`/`--yes` updates Tret itself, and an id selector still prints the display name.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");
const UPDATE_URL = "https://tret.framwrk.com/scripts/install.sh";

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeHome(): string {
  return makeDir("tret-cli-global-");
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function runCliResult(
  args: string[],
  home: string,
  options: { extraEnv?: Record<string, string>; preload?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const spawnArgs =
    options.preload === undefined ? [BUN, TRET, ...args] : [BUN, "--preload", options.preload, TRET, ...args];
  const proc = Bun.spawn(spawnArgs, {
    env: { ...process.env, ...options.extraEnv, HOME: home },
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

/** The user-facing lines the CLI wrote during a run, which survive a piped stdout. */
function runLogText(home: string): string {
  const dir = join(home, ".tret", "logs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function writeRecords(home: string, records: RecordV3[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
}

function readRecords(home: string): { version: number; records: RecordV3[] } {
  return JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as {
    version: number;
    records: RecordV3[];
  };
}

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "none",
      completeness: "heuristic",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

/** Serves one raw script over loopback; an install URL needs a dotted host and a non-HTML body. */
function serve(script: string): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(script, { headers: { "content-type": "text/plain" } }),
  });
  return { url: `http://127.0.0.1:${server.port}/install.sh`, stop: () => server.stop(true) };
}

/** Overrides only the self-update URL, so bare `update` tests never touch the network. */
function makeUpdatePreload(): string {
  const path = join(makeDir("tret-cli-preload-"), "update-fetch.js");
  writeFileSync(
    path,
    `const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input) === ${JSON.stringify(UPDATE_URL)}) {
    return Promise.resolve(new Response("#!/bin/sh\\nexit 0\\n", { headers: { "content-type": "text/plain" } }));
  }
  return realFetch(input, init);
};
`,
  );
  return path;
}

const INSTALL_SCRIPT = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho jsonflag\\n' > "$HOME/.local/bin/jsonflag"
chmod +x "$HOME/.local/bin/jsonflag"
printf '%s' "$*" > "$HOME/script-args.txt"
`;

describe("global --json position", () => {
  test("a leading --json reaches list and inspect instead of printing help", async () => {
    const home = makeHome();
    writeRecords(home, [record()]);

    const listed = await runCliResult(["--json", "list"], home);
    expect(listed.code).toBe(0);
    expect(listed.stdout.trim().startsWith("{")).toBe(true);
    expect(listed.stdout.trim().endsWith("}")).toBe(true);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, command: "list" });

    const inspected = await runCliResult(["--json", "inspect", "mytool"], home);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      ok: true,
      command: "inspect",
      tool: { id: "rec-1", name: "mytool" },
    });
  });

  test("install accepts --json before or after the command and never strips it after --", async () => {
    const server = serve(INSTALL_SCRIPT);
    try {
      const flagFirstHome = makeHome();
      const flagFirst = await runCliResult(["--json", "install", server.url, "--", "--json"], flagFirstHome);
      expect(flagFirst.code).toBe(0);
      expect(JSON.parse(flagFirst.stdout)).toMatchObject({ ok: true, command: "install", tool: "jsonflag" });
      expect(readFileSync(join(flagFirstHome, "script-args.txt"), "utf8")).toBe("--json");

      const flagLastHome = makeHome();
      const flagLast = await runCliResult(["install", server.url, "--json"], flagLastHome);
      expect(flagLast.code).toBe(0);
      expect(JSON.parse(flagLast.stdout)).toMatchObject({ ok: true, command: "install", tool: "jsonflag" });
      expect(readFileSync(join(flagLastHome, "script-args.txt"), "utf8")).toBe("");
    } finally {
      await server.stop();
    }
  });

  test("install with no URL reports the JSON usage error instead of naming --json as the URL", async () => {
    for (const args of [["--json", "install"], ["install", "--json"]]) {
      const home = makeHome();
      const result = await runCliResult(args, home);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: { code: "install-usage", message: "install requires a URL in JSON mode" },
      });
    }
  });
});

describe("update selector parsing", () => {
  test("bare update with --json or --yes updates Tret instead of selecting a flag", async () => {
    const home = makeHome();
    const preload = makeUpdatePreload();

    for (const args of [
      ["--json", "update"],
      ["update", "--json"],
      ["--json", "update", "--yes"],
    ]) {
      const result = await runCliResult(args, home, { preload });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        command: "update",
        target: "tret",
        url: UPDATE_URL,
      });
    }

    const yes = await runCliResult(["update", "--yes"], home, { preload });
    expect(yes.code).toBe(0);
  });

  test("update <tool> with flags after the selector still updates that tool", async () => {
    const script = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho updatetool\\n' > "$HOME/.local/bin/updatetool"
chmod +x "$HOME/.local/bin/updatetool"
`;
    const server = serve(script);
    try {
      for (const args of [
        ["update", "updatetool", "--json", "--yes"],
        ["--json", "update", "updatetool", "--yes"],
      ]) {
        const home = makeHome();
        writeRecords(home, [record({ id: "rec-update", name: "updatetool", url: server.url })]);

        const result = await runCliResult(args, home);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          command: "update",
          tool: "updatetool",
          id: "rec-update",
        });

        const saved = readRecords(home);
        expect(saved.records).toHaveLength(1);
        expect(saved.records[0]?.id).toBe("rec-update");
        expect(saved.records[0]?.executable).toBe(join(home, ".local", "bin", "updatetool"));
      }
    } finally {
      await server.stop();
    }
  });
});

describe("find usage", () => {
  test("a missing or slash-containing name exits 2", async () => {
    const home = makeHome();
    expect((await runCliResult(["find"], home)).code).toBe(2);
    expect((await runCliResult(["find", "some/tool"], home)).code).toBe(2);
  });

  test("a name that is not on PATH still exits 0", async () => {
    const home = makeHome();
    const result = await runCliResult(["find", "tret-cli-missing-command"], home);
    expect(result.code).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("no command named tret-cli-missing-command on PATH");
  });
});

describe("uninstall selector output", () => {
  test("an id selector reports the display name", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool-human");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");
    writeRecords(home, [
      record({
        id: "rec-human",
        name: "mytool-human",
        executable: binary,
        owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }],
      }),
    ]);

    const result = await runCliResult(["uninstall", "rec-human", "--yes"], home);
    expect(result.code).toBe(0);
    expect(existsSync(binary)).toBe(false);
    const output = runLogText(home);
    expect(output).toContain("removed mytool-human");
    expect(output).not.toContain("removed rec-human");
  });

  test("JSON includes the display name as tool and keeps the id", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool-json");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");
    writeRecords(home, [
      record({
        id: "rec-json",
        name: "mytool-json",
        executable: binary,
        owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }],
      }),
    ]);

    const result = await runCliResult(["--json", "uninstall", "rec-json", "--yes"], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "uninstall",
      tool: "mytool-json",
      id: "rec-json",
      removed: [binary],
    });
    expect(existsSync(binary)).toBe(false);
  });
});

/** Seeds a record with an executable under ~/.local/bin, for informational-output tests. */
function writeRecord(home: string): void {
  const executable = join(home, ".local", "bin", "mytool");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\necho mytool\n", { mode: 0o755 });
  writeRecords(home, [
    record({
      executable,
      caseSensitive: false,
      capture: {
        backend: "macos-heuristic",
        completeness: "heuristic",
        segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
      },
      owned: [{ path: executable, kind: "file", installedHash: "b".repeat(64) }],
    }),
  ]);
}

describe("informational output streams", () => {
  test("--version writes the version to a piped stdout without starting a run log", async () => {
    const home = makeHome();
    const result = await runCliResult(["--version"], home);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
    expect(result.stderr).toBe("");
    // The fast path answers before logging or the daily update check: no ~/.tret tree appears.
    expect(existsSync(join(home, ".tret"))).toBe(false);
  });

  test("--help and help write the usage text to a piped stdout", async () => {
    for (const args of [["--help"], ["help"]]) {
      const home = makeHome();
      const result = await runCliResult(args, home);

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
    const result = await runCliResult(["list"], home);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Name");
    expect(result.stdout).toContain("mytool");
    expect(result.stdout).toContain("heuristic");
    expect(result.stderr).toBe("");
  });

  test("human list writes its empty-state line to a piped stdout", async () => {
    const result = await runCliResult(["list"], makeHome());

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("No installs tracked.");
    expect(result.stderr).toBe("");
  });

  test("list --json emits exactly one document and no human table on stdout", async () => {
    const home = makeHome();
    writeRecord(home);
    const result = await runCliResult(["list", "--json"], home);

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
      const result = await runCliResult(["install", server.url, "--no-capture", "--yes"], home);

      expect(result.code).toBe(0);
      // Any line here would have been executed by the `| bash` half of the pasted command.
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("installed myshellpiped");
    } finally {
      await server.stop();
    }
  });
});
