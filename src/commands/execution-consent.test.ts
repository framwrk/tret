import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dirs: string[] = [];
const entry = join(import.meta.dir, "../../index.ts");
const hash = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-consent-"));
  dirs.push(dir);
  return dir;
}

async function run(args: string[], root: string) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...process.env, HOME: root },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function seed(root: string, url: string): string {
  const executable = join(root, ".local/bin/victim");
  mkdirSync(join(root, ".local/bin"), { recursive: true });
  mkdirSync(join(root, ".tret"), { recursive: true });
  writeFileSync(executable, "original", { mode: 0o755 });
  writeFileSync(
    join(root, ".tret/records.json"),
    JSON.stringify({
      version: 3,
      records: [
        {
          id: "consent",
          name: "victim",
          source: "install",
          url,
          installedAt: new Date(0).toISOString(),
          executable,
          scriptSha256: hash("script"),
          capture: {
            backend: "fixture",
            completeness: "complete",
            segments: [{ kind: "install", startedAt: new Date(0).toISOString() }],
          },
          privilege: "user",
          caseSensitive: true,
          owned: [{ path: executable, kind: "file", installedHash: hash("original") }],
          mutated: [],
          deleted: [],
        },
      ],
    }),
  );
  return executable;
}

for (const json of [false, true]) {
  test(`noninteractive install requires --yes (${json ? "JSON" : "human"})`, async () => {
    const root = home();
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++;
        return new Response(
          '#!/bin/sh\nmkdir -p "$HOME/.local/bin"\nprintf ran > "$HOME/.local/bin/probe"\nchmod +x "$HOME/.local/bin/probe"\n',
          { headers: { "content-type": "text/plain" } },
        );
      },
    });
    try {
      const result = await run(["install", `http://127.0.0.1:${server.port}/install.sh`, ...(json ? ["--json"] : [])], root);
      expect(result.code).toBe(5);
      expect(requests).toBe(0);
      expect(existsSync(join(root, ".local/bin/probe"))).toBe(false);
      expect(existsSync(join(root, ".tret/records.json"))).toBe(false);
      if (json) expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "install-consent" } });
    } finally {
      await server.stop(true);
    }
  });
}

test("tracked update without --yes preserves the executable and original record", async () => {
  const root = home();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return new Response('#!/bin/sh\nprintf replacement > "$HOME/.local/bin/victim"\n', {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  try {
    const executable = seed(root, `http://127.0.0.1:${server.port}/install.sh`);
    const before = readFileSync(join(root, ".tret/records.json"), "utf8");
    const result = await run(["update", "victim", "--json"], root);
    expect(result.code).toBe(5);
    expect(requests).toBe(0);
    expect(readFileSync(executable, "utf8")).toBe("original");
    expect(readFileSync(join(root, ".tret/records.json"), "utf8")).toBe(before);
  } finally {
    await server.stop(true);
  }
});

for (const command of ["install", "update"]) {
  test(`JSON ${command} emits one error document when prior cleanup is unapproved`, async () => {
    const root = home();
    const sentinel = join(root, "replacement-ran");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response('#!/bin/sh\nprintf ran > "$HOME/replacement-ran"\n', {
        headers: { "content-type": "text/plain" },
      }),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/install.sh`;
      const executable = seed(root, url);
      const before = readFileSync(join(root, ".tret/records.json"));
      const args = command === "install" ? ["install", url, "--force"] : ["update", "victim"];
      const result = await run(["--json", ...args, "--yes"], root);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "install-previous-blocked" } });
      expect(readFileSync(join(root, ".tret/records.json"))).toEqual(before);
      expect(readFileSync(executable, "utf8")).toBe("original");
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
}

for (const args of [
  ["uninstall", "victim", "--yes", "--forc"],
  ["uninstall", "victim", "extra", "--yes"],
  ["update", "--yess"],
  ["update", "victim", "extra", "--yes"],
  ["update", "victim", "--version"],
  ["install", "https://example.com/install.sh", "--ye"],
  ["install", "--name", "curl", "https://example.com/install.sh", "--ye"],
  ["install", "https://example.com/install.sh", "extra", "--yes"],
  ["install", "https://example.com/install.sh", "--name", "a", "--name", "b", "--yes"],
  ["uninstall", "victim", "--yes", "--", "--force"],
  ["list", "extra"],
  ["unknown-command"],
]) {
  test(`invalid invocation refuses before dispatch: ${args.join(" ")}`, async () => {
    const root = home();
    const executable = seed(root, "https://example.com/install.sh");
    const before = readFileSync(join(root, ".tret/records.json"), "utf8");
    // A preload makes any accidental network call a local test failure rather than a download.
    const preload = join(root, "fetch-guard.ts");
    writeFileSync(
      preload,
      'globalThis.fetch = async () => { await Bun.write(`${process.env.HOME}/unexpected-fetch`, "called"); throw new Error("unexpected fetch"); };',
    );
    const child = Bun.spawn([process.execPath, "--preload", preload, entry, "--json", ...args], {
      env: { ...process.env, HOME: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(existsSync(join(root, "unexpected-fetch"))).toBe(false);
    expect(readFileSync(executable, "utf8")).toBe("original");
    expect(readFileSync(join(root, ".tret/records.json"), "utf8")).toBe(before);
  });
}

test("uninstall flags before a selector preview that selector without changing it", async () => {
  const root = home();
  const executable = seed(root, "https://example.com/install.sh");
  expect((await run(["approve", "victim", executable, "--remove", "--yes", "--json"], root)).code).toBe(0);
  const result = await run(["uninstall", "--dry-run", "victim", "--json"], root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, tool: "victim" });
  expect(readFileSync(executable, "utf8")).toBe("original");
});

test("JSON help and version each emit one document", async () => {
  for (const args of [["--help"], ["--version"], []]) {
    const result = await run(["--json", ...args], home());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  }
});

test("pasted curl/wget inputs preserve script arguments and require Tret's own consent", async () => {
  const script =
    '#!/bin/sh\nset -eu\nmkdir -p "$HOME/.local/bin"\nprintf "#!/bin/sh\\necho paste\\n" > "$HOME/.local/bin/paste"\nchmod +x "$HOME/.local/bin/paste"\nprintf "%s" "$*" > "$HOME/arguments"\n';
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(script, { headers: { "content-type": "text/plain" } }),
  });
  const url = `http://127.0.0.1:${server.port}/install.sh`;
  try {
    for (const paste of [
      ["curl", "-fsSL", url],
      ["wget", "-qO-", url],
      [`curl -fsSL ${url} | bash`],
      ["curl", "--proto", "=https", "--tlsv1.2", "-sSf", url],
      ["curl", "-fsSL", url, "|", "sudo", "bash"],
      ["wget", "--quiet", "-O-", url],
    ]) {
      const root = home();
      const result = await run(["--json", "install", ...paste, "--yes", "--", "--json", "--force"], root);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, tool: "paste" });
      expect(readFileSync(join(root, "arguments"), "utf8")).toBe("--json --force");
    }
    const root = home();
    const refused = await run(["--json", "install", url, "--", "--yes"], root);
    expect(refused.code).toBe(5);
    expect(existsSync(join(root, ".local/bin/paste"))).toBe(false);
  } finally {
    await server.stop(true);
  }
});
