// Linux release-acceptance harness for the built `tret` binary.
//
// This is the durable, repeatable half of the plan's verification gate: it drives the *shipped*
// artifact (not the TypeScript sources) through the ten Linux findings that the v0.5.0 validation
// report reproduced. Every run gets a throwaway `$HOME` and loopback HTTP installers, and the
// harness snapshots the real host before and after to prove it was not touched.
//
// Usage:
//   bash scripts/build.sh linux-x64
//   bun scripts/linux-acceptance.ts
//   TRET_BIN=/path/to/tret bun scripts/linux-acceptance.ts
//
// Environment:
//   TRET_BIN                 release artifact to exercise (default dist/tret-linux-<arch>)
//   TRET_ACCEPTANCE_STRICT   set to 1 in CI so an environment skip fails the release gate
//
// The host's real `$HOME`, `~/.tret`, shell configs, and `/etc/profile.d` are only ever read. The
// script refuses to start when the artifact is missing instead of reporting a green no-op.

import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Stats } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const REAL_HOME = process.env.HOME ?? homedir();
const STRICT = process.env.TRET_ACCEPTANCE_STRICT === "1";
const COMMAND_TIMEOUT_MS = 120_000;
const HOST_PATHS = [".tret/records.json", ".bashrc", ".profile", ".config/fish/config.fish"];
const PROFILE_DIR = "/etc/profile.d";

/** One captured record, narrowed to the fields these assertions read. */
type CapturedRecord = {
  id: string;
  name: string;
  source: "install" | "find";
  url: string;
  installedAt: string;
  executable: string;
  scriptSha256: string;
  capture: {
    backend: string;
    completeness: string;
    segments: { kind: string; startedAt: string; endedAt?: string; partialReason?: string }[];
  };
  privilege: string;
  caseSensitive: boolean;
  owned: { path: string; kind: string; installedHash?: string; linkTarget?: string }[];
  mutated: { path: string; installedHash?: string; beforeBlob?: string }[];
  deleted: { path: string; installedHash?: string; beforeBlob?: string }[];
};

type RunResult = { code: number; stdout: string; stderr: string };
type ScenarioResult = { name: string; status: "pass" | "skip"; reason?: string };
type HostSnapshotEntry =
  | { path: string; state: "absent" }
  | { path: string; state: "directory" }
  | { path: string; state: "file"; sha256: string; size: number }
  | { path: string; state: "unreadable"; error: string };

/** A scenario that cannot be exercised on this host; `reason` says exactly why. */
class SkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipError";
  }
}

/** Wraps the first failing scenario so the top level can print its name and output. */
class ScenarioFailure extends Error {
  readonly scenario: string;

  constructor(scenario: string, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ScenarioFailure";
    this.scenario = scenario;
  }
}

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tret-acceptance-${label}-`));
  temporaryRoots.push(dir);
  return dir;
}

function cleanup(): void {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function includes(text: string, needle: string, label: string): void {
  assert(text.includes(needle), `${label}: expected to find ${JSON.stringify(needle)}\n--- output ---\n${text}`);
}

function excludes(text: string, needle: string, label: string): void {
  assert(!text.includes(needle), `${label}: did not expect ${JSON.stringify(needle)}\n--- output ---\n${text}`);
}

function sha256(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function resolveBinary(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const requested = process.env.TRET_BIN;
  const binary = requested === undefined ? join(ROOT, "dist", `tret-linux-${arch}`) : resolve(requested);
  const origin = requested === undefined ? "the default Linux release artifact" : "TRET_BIN";
  if (!existsSync(binary)) {
    console.error(
      `linux-acceptance: FAIL: missing ${origin} at ${binary}\n` +
        "Build it first with: bash scripts/build.sh linux-" +
        arch,
    );
    process.exit(1);
  }
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    console.error(`linux-acceptance: FAIL: ${binary} is not executable`);
    process.exit(1);
  }
  return binary;
}

function childEnvironment(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // The child must never inherit a path back to the real user state, and an explicit helper
  // override from the caller would make the selected capture backend differ from a stock install.
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TRET_FANOTIFY", "TRET_VERSION"]) {
    delete env[key];
  }
  env.HOME = home;
  const scratch = join(dirname(home), "tmp");
  mkdirSync(scratch, { recursive: true });
  env.TMPDIR = scratch;
  env.TMP = scratch;
  env.TEMP = scratch;
  return env;
}

async function runProcess(
  argv: string[],
  env: Record<string, string>,
  cwd: string = ROOT,
): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    assert(!controller.signal.aborted, `command timed out after ${COMMAND_TIMEOUT_MS}ms: ${argv.join(" ")}`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function runTret(
  home: string,
  args: string[],
  binary: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  assert(
    resolve(home) !== resolve(REAL_HOME),
    `refusing to run the acceptance binary against the real HOME (${REAL_HOME})`,
  );
  return runProcess([binary, ...args], { ...childEnvironment(home), ...extraEnv });
}

function expectSuccess(result: RunResult, label: string): void {
  if (result.code === 0) return;
  throw new Error(
    `${label} exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
}

function expectExit(result: RunResult, expected: number, label: string): void {
  if (result.code === expected) return;
  throw new Error(
    `${label} exited ${result.code}, expected ${expected}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
}

function parseJson(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    const value: unknown = JSON.parse(trimmed);
    assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: stdout was not a JSON object`);
    return value as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: stdout was not exactly one JSON document (${detail})\n--- stdout ---\n${text}`, {
      cause: error,
    });
  }
}

function readRecords(home: string): CapturedRecord[] {
  const path = join(home, ".tret", "records.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records?: CapturedRecord[] };
  assert(Array.isArray(parsed.records), `${path} does not contain a records array`);
  return parsed.records;
}

function writeRecords(home: string, records: CapturedRecord[]): void {
  const dir = join(home, ".tret");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "records.json"), `${JSON.stringify({ version: 3, records }, null, 2)}\n`);
}

/** A valid v3 record whose only effects are the ones one scenario needs to reproduce. */
function seedRecord(fixture: {
    id: string;
    name: string;
    url: string;
    script: string;
    executable?: string;
    owned?: CapturedRecord["owned"];
    mutated?: CapturedRecord["mutated"];
  },
): CapturedRecord {
  return {
    id: fixture.id,
    name: fixture.name,
    source: "install",
    url: fixture.url,
    installedAt: "2026-10-01T00:00:00.000Z",
    executable: fixture.executable ?? "",
    scriptSha256: sha256(fixture.script),
    capture: {
      backend: "none",
      completeness: "heuristic",
      segments: [{ kind: "install", startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: fixture.owned ?? [],
    mutated: fixture.mutated ?? [],
    deleted: [],
  };
}

/** Loopback HTTP fixture server; each route serves one local installer script. */
class FixtureServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly scripts: Map<string, string>;

  private constructor(server: ReturnType<typeof Bun.serve>, scripts: Map<string, string>) {
    this.server = server;
    this.scripts = scripts;
  }

  static start(): FixtureServer {
    const scripts = new Map<string, string>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        const body = scripts.get(path);
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(body, { headers: { "content-type": "text/plain" } });
      },
    });
    return new FixtureServer(server, scripts);
  }

  add(path: string, script: string): string {
    this.scripts.set(path, script);
    return this.url(path);
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.server.port}${path}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

type ScenarioContext = { home: string; work: string };

function contextFor(label: string): ScenarioContext {
  const root = temporaryRoot(label);
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { home, work };
}

function yamaPtraceScope(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
  } catch {
    return undefined;
  }
}

function bwrapUsable(): boolean {
  const bwrap = Bun.which("bwrap");
  if (bwrap === null) return false;
  const probe = Bun.spawnSync([bwrap, "--dev-bind", "/", "/", "true"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
}

function isExecutable(path: string): boolean {
  try {
    const stats: Stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function snapshotFile(path: string): HostSnapshotEntry {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, state: "absent" };
    return { path, state: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
  if (stats.isDirectory()) return { path, state: "directory" };
  try {
    const bytes = readFileSync(path);
    return { path, state: "file", sha256: sha256(bytes), size: bytes.byteLength };
  } catch (error) {
    return { path, state: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Hashes the real user state and every `/etc/profile.d` entry; absent paths are recorded as absent. */
function hostSnapshot(): HostSnapshotEntry[] {
  const entries: HostSnapshotEntry[] = HOST_PATHS.map((relative) => snapshotFile(join(REAL_HOME, relative)));
  if (!existsSync(PROFILE_DIR)) {
    entries.push({ path: PROFILE_DIR, state: "absent" });
  } else {
    entries.push(snapshotFile(PROFILE_DIR));
    for (const name of readdirSync(PROFILE_DIR).sort()) entries.push(snapshotFile(join(PROFILE_DIR, name)));
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function describeSnapshotDifference(before: HostSnapshotEntry[], after: HostSnapshotEntry[]): string | undefined {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const differences: string[] = [];
  for (const path of [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort()) {
    const oldEntry = beforeByPath.get(path);
    const newEntry = afterByPath.get(path);
    if (JSON.stringify(oldEntry) === JSON.stringify(newEntry)) continue;
    differences.push(`\t${path}\n\t\tbefore: ${JSON.stringify(oldEntry)}\n\t\tafter:  ${JSON.stringify(newEntry)}`);
  }
  return differences.length === 0 ? undefined : differences.join("\n");
}

// Installer fixtures. They only write inside the temporary HOME; none of them needs root.

const PROBE_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/probe"
printf '#!/bin/sh\\necho probe\\n' > "$HOME/.local/bin/probe"
chmod +x "$HOME/.local/bin/probe"
printf 'cfg\\n' > "$HOME/.config/probe/config"
`;

const TRACED_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho run >> "$HOME/.trace-runs"\\nmkdir -p "$HOME/.local/share/traced"\\nprintf "state\\\\n" > "$HOME/.local/share/traced/state"\\n' > "$HOME/.local/bin/traced"
chmod +x "$HOME/.local/bin/traced"
`;

const SHARED_PARENT_A = `#!/bin/bash
set -e
mkdir -p "$HOME/.sharedparent" "$HOME/.local/bin"
printf '#!/bin/sh\\necho shared-a\\n' > "$HOME/.local/bin/shared-a"
chmod +x "$HOME/.local/bin/shared-a"
printf 'a\\n' > "$HOME/.sharedparent/a.conf"
`;

const SHARED_PARENT_B = `#!/bin/bash
set -e
mkdir -p "$HOME/.sharedparent" "$HOME/.local/bin"
printf '#!/bin/sh\\necho shared-b\\n' > "$HOME/.local/bin/shared-b"
chmod +x "$HOME/.local/bin/shared-b"
printf 'b\\n' > "$HOME/.sharedparent/b.conf"
`;

const NO_CAPTURE_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/nct" "$HOME/.nct-state"
printf '#!/bin/sh\\necho nct\\n' > "$HOME/.local/bin/nct"
chmod +x "$HOME/.local/bin/nct"
ln -s nct "$HOME/.local/bin/nct-link"
printf 'setting = 1\\n' > "$HOME/.config/nct/config"
`;

const NO_EXECUTABLE_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.config/noexec"
printf 'config\\n' > "$HOME/.config/noexec/config"
printf 'state\\n' > "$HOME/.local/share/noexec-state"
`;

const PATH_LINES_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho pathfixture\\n' > "$HOME/.local/bin/pathfixture"
chmod +x "$HOME/.local/bin/pathfixture"
printf '%s\\n' 'export PATH="$HOME/.local/bin:$PATH" # pathfixture' >> "$HOME/.bashrc"
printf '%s\\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
`;

const UNMARKED_PATH_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho unmarked\\n' > "$HOME/.local/bin/unmarked"
chmod +x "$HOME/.local/bin/unmarked"
printf '%s\\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
`;

const ETC_FIXTURE_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/etcfixture"
printf '#!/bin/sh\\necho etcfixture\\n' > "$HOME/.local/bin/etcfixture"
chmod +x "$HOME/.local/bin/etcfixture"
printf 'cfg\\n' > "$HOME/.config/etcfixture/config"
`;

const GC_KEEP_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/gctool"
printf '#!/bin/sh\\necho gctool-keep\\n' > "$HOME/.local/bin/gctool-keep"
chmod +x "$HOME/.local/bin/gctool-keep"
printf 'keep-new\\n' > "$HOME/.config/gctool/keep.conf"
`;

const GC_GONE_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin" "$HOME/.config/gconetool"
printf '#!/bin/sh\\necho gctool-gone\\n' > "$HOME/.local/bin/gctool-gone"
chmod +x "$HOME/.local/bin/gctool-gone"
printf 'gone-new\\n' > "$HOME/.config/gconetool/gone.conf"
`;

const GC_TRIGGER_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho gctrigger\\n' > "$HOME/.local/bin/gctrigger"
chmod +x "$HOME/.local/bin/gctrigger"
`;

/** Shared PATH cleanup: one marked line is cleaned, the identical unmarked line survives. */
async function scenarioPathLineCleanup(binary: string): Promise<void> {
  const marked = contextFor("path-marked");
  const markedServer = FixtureServer.start();
  try {
    const url = markedServer.add("/install.sh", PATH_LINES_INSTALLER);
    // `~/.local/bin` already exists, so it is a *shared* directory and not owned by this install:
    // only the marked line may be cleaned.
    mkdirSync(join(marked.home, ".local", "bin"), { recursive: true });
    writeFileSync(join(marked.home, ".bashrc"), "initial\n");
    expectSuccess(await runTret(marked.home, ["install", url], binary), "install pathfixture");

    const bashrc = join(marked.home, ".bashrc");
    const record = readRecords(marked.home)[0];
    assert(record !== undefined, "pathfixture install left no record");
    assert(
      record.mutated.some((entry) => entry.path === bashrc && entry.installedHash !== undefined),
      "pathfixture record did not attribute ~/.bashrc with an installed hash",
    );

    const result = await runTret(marked.home, ["uninstall", "pathfixture", "--yes"], binary);
    expectSuccess(result, "uninstall pathfixture");
    const remaining = readFileSync(bashrc, "utf8");
    const markedLine = 'export PATH="$HOME/.local/bin:$PATH" # pathfixture';
    const unmarkedLine = 'export PATH="$HOME/.local/bin:$PATH"';
    assert(!remaining.includes(markedLine), `marked shared PATH line was not cleaned:\n${remaining}`);
    assert(remaining.includes(unmarkedLine), `identical unmarked PATH line was removed:\n${remaining}`);
    const cleanedLines = result.stderr.split("\n").filter((line) => line.includes(`cleaned ${bashrc}:`));
    assertEqual(cleanedLines.length, 1, `cleaned ${bashrc} line count`);
    includes(result.stderr, `would clean ${bashrc}:`, "uninstall preview");
    excludes(result.stderr, `detected ${bashrc}`, "cleanup of an attributed file");
    assertEqual(readRecords(marked.home).length, 0, "records after pathfixture uninstall");
  } finally {
    markedServer.stop();
  }

  // Detect-only output: an unmarked shared line is never fabricated away, and the preview/apply
  // pair must report the unresolved file exactly once.
  const detect = contextFor("path-detect");
  const detectServer = FixtureServer.start();
  try {
    const url = detectServer.add("/install.sh", UNMARKED_PATH_INSTALLER);
    mkdirSync(join(detect.home, ".local", "bin"), { recursive: true });
    writeFileSync(join(detect.home, ".bashrc"), "initial\n");
    expectSuccess(await runTret(detect.home, ["install", url], binary), "install unmarked");

    const bashrc = join(detect.home, ".bashrc");
    const result = await runTret(detect.home, ["uninstall", "unmarked", "--yes"], binary);
    expectSuccess(result, "uninstall unmarked");
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    assert(readFileSync(bashrc, "utf8").includes(line), "unmarked shared PATH line was removed");
    const detected = result.stderr.split("\n").filter((entry) => entry.includes(`detected ${bashrc} changed during install`));
    assertEqual(detected.length, 1, `detect-only output count for ${bashrc}`);
    excludes(result.stderr, `cleaned ${bashrc}`, "detect-only shared line");
  } finally {
    detectServer.stop();
  }
}

/** `--no-capture` records fingerprints for additions, so an ordinary uninstall removes them. */
async function scenarioNoCaptureUninstall(binary: string): Promise<void> {
  const ctx = contextFor("no-capture");
  const server = FixtureServer.start();
  try {
    const url = server.add("/install.sh", NO_CAPTURE_INSTALLER);
    expectSuccess(await runTret(ctx.home, ["install", url, "--no-capture"], binary), "install --no-capture");

    const executable = join(ctx.home, ".local", "bin", "nct");
    const link = join(ctx.home, ".local", "bin", "nct-link");
    const configDir = join(ctx.home, ".config", "nct");
    const stateDir = join(ctx.home, ".nct-state");
    const record = readRecords(ctx.home)[0];
    assert(record !== undefined, "no-capture install left no record");
    assertEqual(record.capture.backend, "none", "no-capture backend");
    const owned = new Map(record.owned.map((entry) => [entry.path, entry]));
    assertEqual(owned.get(executable)?.kind, "file", "nct executable kind");
    assertEqual(owned.get(link)?.kind, "symlink", "nct symlink kind");
    assertEqual(owned.get(link)?.linkTarget, "nct", "nct symlink target");
    assertEqual(owned.get(configDir)?.kind, "directory", "nct config directory kind");
    assertEqual(owned.get(stateDir)?.kind, "directory", "nct state directory kind");
    assert(/^[0-9a-f]{64}$/.test(owned.get(executable)?.installedHash ?? ""), "nct executable was not fingerprinted");
    assert(record.owned.every((entry) => entry.kind !== "unknown"), "no-capture additions kept an unknown kind");

    expectSuccess(await runTret(ctx.home, ["uninstall", "nct", "--yes"], binary), "uninstall nct");
    assert(!existsSync(executable), "uninstall left the nct executable");
    assert(!existsSync(link), "uninstall left the nct symlink");
    assert(!existsSync(configDir), "uninstall left the nct config directory");
    assert(!existsSync(stateDir), "uninstall left the nct state directory");
    assertEqual(readRecords(ctx.home).length, 0, "records after nct uninstall");
  } finally {
    server.stop();
  }
}

/** Global `--json` before the command routes the command and keeps stdout to one document. */
async function scenarioJsonBeforeCommand(binary: string): Promise<void> {
  const ctx = contextFor("json-first");
  const server = FixtureServer.start();
  try {
    const url = server.add("/install.sh", PROBE_INSTALLER);
    expectSuccess(await runTret(ctx.home, ["install", url], binary), "install probe");

    const listed = await runTret(ctx.home, ["--json", "list"], binary);
    expectSuccess(listed, "--json list");
    const document = parseJson(listed.stdout, "--json list");
    assertEqual(document.ok, true, "--json list ok");
    assertEqual(document.command, "list", "--json list command");
    const tools = document.tools;
    assert(Array.isArray(tools), "--json list has no tools array");
    assertEqual(tools.length, 1, "--json list tool count");
    assertEqual((tools[0] as { name?: string }).name, "probe", "--json list tool name");

    const inspected = await runTret(ctx.home, ["--json", "inspect", "probe"], binary);
    expectSuccess(inspected, "--json inspect");
    const report = parseJson(inspected.stdout, "--json inspect");
    assertEqual(report.command, "inspect", "--json inspect command");
    const tool = report.tool;
    assert(tool !== null && typeof tool === "object", "--json inspect has no tool object");
    assertEqual((tool as { name?: string }).name, "probe", "--json inspect tool name");
  } finally {
    server.stop();
  }
}

/**
 * Trace under stock Yama. With `ptrace_scope=1` the unprivileged strace primary cannot attach to
 * its parent, so the shipped binary must fall back to the labeled heuristic window exactly once.
 */
async function scenarioTraceYama(binary: string): Promise<void> {
  const scope = yamaPtraceScope();
  if (scope !== "1") {
    throw new SkipError(
      scope === undefined
        ? "host has no /proc/sys/kernel/yama/ptrace_scope; cannot reproduce the stock Yama ptrace_scope=1 path"
        : `host ptrace_scope=${scope}; scenario requires the reported stock value 1`,
    );
  }

  const ctx = contextFor("trace");
  const server = FixtureServer.start();
  try {
    const url = server.add("/install.sh", TRACED_INSTALLER);
    expectSuccess(await runTret(ctx.home, ["install", url], binary), "install traced");

    const traced = await runTret(ctx.home, ["trace", "traced", "--yes", "--json"], binary);
    expectSuccess(traced, "trace traced");
    const document = parseJson(traced.stdout, "trace --json");
    assertEqual(document.backend, "linux-heuristic", "trace backend");
    assertEqual(document.completeness, "heuristic", "trace completeness");
    assertEqual(document.exitCode, 0, "trace tool exit code");

    const marker = join(ctx.home, ".trace-runs");
    assert(existsSync(marker), "traced tool was not executed");
    const runs = readFileSync(marker, "utf8").trim().split("\n");
    assertEqual(runs.length, 1, "traced tool run count");

    const record = readRecords(ctx.home)[0];
    assert(record !== undefined, "traced install left no record");
    assertEqual(record.capture.segments.length, 2, "capture segment count after trace");
    assertEqual(record.capture.segments[1]?.kind, "trace", "second segment kind");
    assert(record.capture.segments[1]?.endedAt !== undefined, "trace segment has no end time");
  } finally {
    server.stop();
  }
}

/** Forced replacement of a tool whose parent directory is shared leaves the other tool intact. */
async function scenarioSharedParentReplacement(binary: string): Promise<void> {
  const ctx = contextFor("shared-parent");
  const server = FixtureServer.start();
  try {
    const urlA = server.add("/a.sh", SHARED_PARENT_A);
    const urlB = server.add("/b.sh", SHARED_PARENT_B);
    expectSuccess(await runTret(ctx.home, ["install", urlA], binary), "install shared-a");
    expectSuccess(await runTret(ctx.home, ["install", urlB], binary), "install shared-b");

    const sharedParent = join(ctx.home, ".sharedparent");
    const aFile = join(sharedParent, "a.conf");
    const bFile = join(sharedParent, "b.conf");
    const bExecutable = join(ctx.home, ".local", "bin", "shared-b");
    const previousA = readRecords(ctx.home).find((record) => record.name === "shared-a");
    assert(previousA !== undefined, "shared-a install left no record");
    assert(
      previousA.owned.some((entry) => entry.path === sharedParent),
      "shared-a did not own the shared parent directory",
    );

    expectSuccess(await runTret(ctx.home, ["install", urlA, "--force"], binary), "force reinstall shared-a");

    assertEqual(readFileSync(aFile, "utf8"), "a\n", "shared-a file after forced replacement");
    assertEqual(readFileSync(bFile, "utf8"), "b\n", "shared-b file after forced replacement");
    assert(isExecutable(bExecutable), "shared-b executable was removed");
    const records = readRecords(ctx.home);
    const aRecords = records.filter((record) => record.name === "shared-a");
    assertEqual(aRecords.length, 1, "shared-a record count");
    assert(aRecords[0]?.id !== previousA.id, "shared-a record was not replaced");
    assertEqual(aRecords[0]?.executable, join(ctx.home, ".local", "bin", "shared-a"), "shared-a executable");
    assert(
      aRecords[0]?.owned.some((entry) => entry.path === aFile),
      "replacement record does not own the new shared-a file",
    );
    assertEqual(
      records.filter((record) => record.name === "shared-b").length,
      1,
      "shared-b record count",
    );
    assert(records.every((record) => record.executable !== ""), "forced replacement left a partial record");
    assert(
      !records.some((record) => record.owned.length === 1 && record.owned[0]?.path === sharedParent),
      "forced replacement left a stuck parent-directory-only record",
    );
  } finally {
    server.stop();
  }
}

/** Forced reinstall must not touch an unattributed shell config, including `/etc/profile.d`. */
async function scenarioForcedShellCleanup(binary: string): Promise<void> {
  const ctx = contextFor("forced-shell");
  const server = FixtureServer.start();
  const notes: string[] = [];
  try {
    const url = server.add("/etcfixture.sh", ETC_FIXTURE_INSTALLER);
    const homePath = `export PATH=$HOME/.config/bin:$PATH\n`;

    // The same selection rule using temporary HOME configs, always exercised.
    const bashrc = join(ctx.home, ".bashrc");
    const profile = join(ctx.home, ".profile");
    writeFileSync(bashrc, homePath);
    writeFileSync(profile, homePath);
    writeRecords(ctx.home, [
      seedRecord({
        id: "rec-etcfixture-home",
        name: "etcfixture",
        url,
        script: ETC_FIXTURE_INSTALLER,
        executable: join(ctx.home, ".local", "bin", "etcfixture"),
        owned: [{ path: join(ctx.home, ".config"), kind: "directory" }],
        mutated: [{ path: bashrc, installedHash: sha256(homePath) }],
      }),
    ]);

    const replaced = await runTret(ctx.home, ["install", url, "--force"], binary);
    expectSuccess(replaced, "forced reinstall with unattributed HOME config");
    assertEqual(readFileSync(bashrc, "utf8"), "", "attributed ~/.bashrc after forced reinstall");
    assertEqual(readFileSync(profile, "utf8"), homePath, "unattributed ~/.profile after forced reinstall");
    includes(replaced.stderr, `cleaned ${bashrc}`, "forced reinstall cleaned the attributed config");
    excludes(replaced.stderr, `cleaned ${profile}`, "forced reinstall claimed an unattributed config");
    const homeRecords = readRecords(ctx.home);
    assertEqual(homeRecords.length, 1, "record count after HOME-config replacement");
    assert(
      !homeRecords[0]?.mutated.some((entry) => entry.path === profile),
      "replacement record claimed the unattributed ~/.profile",
    );

    // The absolute Linux snippet directory, exercised under a private mount namespace when the host
    // allows it so the real /etc/profile.d is never opened for writing.
    if (!bwrapUsable() || !existsSync(PROFILE_DIR)) {
      notes.push(
        existsSync(PROFILE_DIR)
          ? "bwrap is unavailable (or cannot create a mount namespace); /etc/profile.d was only verified unchanged"
          : `${PROFILE_DIR} does not exist on this host; the absolute snippet variant was skipped`,
      );
    } else {
      const bwrap = Bun.which("bwrap")!;
      const snippetDir = join(ctx.work, "profile.d");
      mkdirSync(snippetDir, { recursive: true });
      const attributedOnHost = join(snippetDir, "mytool.sh");
      const unattributedOnHost = join(snippetDir, "other.sh");
      const attributedInSandbox = join(PROFILE_DIR, "mytool.sh");
      const unattributedInSandbox = join(PROFILE_DIR, "other.sh");
      const snippetLine = "export PATH=/etc/profile.d/bin:$PATH\n";
      writeFileSync(attributedOnHost, snippetLine);
      writeFileSync(unattributedOnHost, snippetLine);

      const etcHome = contextFor("forced-etc").home;
      writeRecords(etcHome, [
        seedRecord({
          id: "rec-etcfixture-etc",
          name: "etcfixture",
          url,
          script: ETC_FIXTURE_INSTALLER,
          executable: join(etcHome, ".local", "bin", "etcfixture"),
          owned: [{ path: PROFILE_DIR, kind: "directory" }],
          mutated: [{ path: attributedInSandbox, installedHash: sha256(snippetLine) }],
        }),
      ]);

      const inside = await runProcess(
        [
          bwrap,
          "--dev-bind",
          "/",
          "/",
          "--bind",
          snippetDir,
          PROFILE_DIR,
          "--chdir",
          ROOT,
          binary,
          "install",
          url,
          "--force",
        ],
        childEnvironment(etcHome),
      );
      expectSuccess(inside, "forced reinstall under a private /etc/profile.d mount");
      assertEqual(
        readFileSync(attributedOnHost, "utf8"),
        "",
        "attributed /etc/profile.d snippet after forced reinstall",
      );
      assertEqual(
        readFileSync(unattributedOnHost, "utf8"),
        snippetLine,
        "unattributed /etc/profile.d snippet after forced reinstall",
      );
      includes(inside.stderr, `cleaned ${attributedInSandbox}`, "forced reinstall cleaned the attributed snippet");
      excludes(inside.stderr, `cleaned ${unattributedInSandbox}`, "forced reinstall claimed the unattributed snippet");
      excludes(inside.stderr, `cleaned ${PROFILE_DIR}:`, "forced reinstall treated the snippet directory as a file");
      const etcRecords = readRecords(etcHome);
      assertEqual(etcRecords.length, 1, "record count after /etc/profile.d replacement");
      assert(
        ![...etcRecords[0]!.owned, ...etcRecords[0]!.mutated].some((entry) =>
          entry.path.startsWith(`${PROFILE_DIR}/`),
        ),
        "replacement record claimed an /etc/profile.d path it did not mutate",
      );
    }

    for (const note of notes) process.stdout.write(`  note: ${note}\n`);
  } finally {
    server.stop();
  }
}

/** Bare `update` flags must never become a selector; the self-update fetch is blocked locally. */
async function scenarioBareUpdateFlags(binary: string): Promise<void> {
  const ctx = contextFor("update-bare");
  const server = FixtureServer.start();
  try {
    const url = server.add("/install.sh", PROBE_INSTALLER);
    expectSuccess(await runTret(ctx.home, ["install", url], binary), "install probe");
    const before = readRecords(ctx.home)[0];
    assert(before !== undefined, "probe install left no record");

    // Prove this Bun runtime honours the proxy override before letting the binary reach the update
    // path; otherwise the real published installer would run inside the sandbox.
    const proxy = "http://127.0.0.1:1";
    const proxyEnv = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "" };
    const savedProxyEnv = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY,
    };
    let blocked = false;
    try {
      Object.assign(process.env, proxyEnv);
      await fetch("https://tret.framwrk.com/scripts/install.sh", { signal: AbortSignal.timeout(5000) });
    } catch {
      blocked = true;
    } finally {
      for (const [key, value] of Object.entries(savedProxyEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert(blocked, "Bun ignored the local proxy; refusing to exercise the real self-update URL");

    const jsonUpdate = await runTret(ctx.home, ["update", "--json"], binary, proxyEnv);
    const document = parseJson(jsonUpdate.stdout, "update --json");
    assertEqual(jsonUpdate.code, 1, "update --json exit code");
    const error = document.error;
    assert(error !== null && typeof error === "object", "update --json error document has no error object");
    assertEqual((error as { code?: string }).code, "update-fetch", "update --json error code");
    includes(jsonUpdate.stderr, "could not download the update script", "update --json");

    const yesUpdate = await runTret(ctx.home, ["update", "--yes"], binary, proxyEnv);
    expectExit(yesUpdate, 1, "update --yes");
    includes(yesUpdate.stderr, "could not download the update script", "update --yes");
    excludes(yesUpdate.stderr, "no tracked install matched", "update --yes selector resolution");
    excludes(yesUpdate.stderr, "updating ", "update --yes tracked-tool path");

    const after = readRecords(ctx.home)[0];
    assertEqual(after?.id, before.id, "bare update changed the tracked record");
    assertEqual(after?.installedAt, before.installedAt, "bare update reinstalled the tracked tool");
  } finally {
    server.stop();
  }
}

/** A fresh no-executable install keeps a partial record whose changes uninstall can remove. */
async function scenarioNoExecutablePartialRecord(binary: string): Promise<void> {
  const ctx = contextFor("no-executable");
  const server = FixtureServer.start();
  try {
    const url = server.add("/install.sh", NO_EXECUTABLE_INSTALLER);
    const installed = await runTret(ctx.home, ["install", url, "--name", "noexec-tool"], binary);
    expectExit(installed, 1, "no-executable install");

    const config = join(ctx.home, ".config", "noexec", "config");
    const configDir = join(ctx.home, ".config", "noexec");
    const state = join(ctx.home, ".local", "share", "noexec-state");
    const records = readRecords(ctx.home);
    assertEqual(records.length, 1, "partial record count");
    const record = records[0]!;
    assertEqual(record.name, "noexec-tool", "partial record name");
    assertEqual(record.executable, "", "partial record executable");
    assertEqual(record.capture.completeness, "partial", "partial record completeness");
    assert(
      record.capture.segments[0]?.partialReason?.includes("no executable command") === true,
      "partial record does not explain the missing executable",
    );
    assert(
      record.owned.some((entry) => entry.path === config),
      "partial record does not own the installer's config file",
    );

    const listed = await runTret(ctx.home, ["list"], binary);
    expectSuccess(listed, "list partial record");
    const row = listed.stdout.split("\n").find((line) => line.startsWith("noexec-tool "));
    assert(row !== undefined, `list did not show noexec-tool:\n${listed.stdout}`);
    assert(/\bpartial\s+-\s/.test(row), `list did not show the partial record without a binary: ${row}`);

    expectSuccess(await runTret(ctx.home, ["uninstall", "noexec-tool", "--yes"], binary), "uninstall noexec-tool");
    assert(!existsSync(config), "uninstall left the no-executable config file");
    assert(!existsSync(configDir), "uninstall left the no-executable config directory");
    assert(!existsSync(state), "uninstall left the no-executable state file");
    assertEqual(readRecords(ctx.home).length, 0, "records after noexec-tool uninstall");
  } finally {
    server.stop();
  }
}

/** Backup blobs: grace protects a fresh orphan, aging lets a later command reclaim it, references win. */
async function scenarioBackupBlobGc(binary: string): Promise<void> {
  const ctx = contextFor("backup-gc");
  const server = FixtureServer.start();
  try {
    const keepUrl = server.add("/keep.sh", GC_KEEP_INSTALLER);
    const goneUrl = server.add("/gone.sh", GC_GONE_INSTALLER);
    const triggerUrl = server.add("/trigger.sh", GC_TRIGGER_INSTALLER);

    mkdirSync(join(ctx.home, ".config", "gctool"), { recursive: true });
    writeFileSync(join(ctx.home, ".config", "gctool", "keep.conf"), "keep-original\n");
    mkdirSync(join(ctx.home, ".config", "gconetool"), { recursive: true });
    writeFileSync(join(ctx.home, ".config", "gconetool", "gone.conf"), "gone-original\n");

    expectSuccess(await runTret(ctx.home, ["install", keepUrl, "--backup"], binary), "install gctool-keep --backup");
    expectSuccess(await runTret(ctx.home, ["install", goneUrl, "--backup"], binary), "install gctool-gone --backup");

    const records = readRecords(ctx.home);
    const keep = records.find((record) => record.name === "gctool-keep");
    const gone = records.find((record) => record.name === "gctool-gone");
    assert(keep !== undefined && gone !== undefined, "backup installs did not create both records");
    const keepBlob = keep.mutated.find((entry) => entry.path.endsWith("keep.conf"))?.beforeBlob;
    const goneBlob = gone.mutated.find((entry) => entry.path.endsWith("gone.conf"))?.beforeBlob;
    assert(keepBlob !== undefined, "gctool-keep did not store a before-image blob");
    assert(goneBlob !== undefined, "gctool-gone did not store a before-image blob");
    const objects = join(ctx.home, ".tret", "objects");
    const keepObject = join(objects, keepBlob);
    const goneObject = join(objects, goneBlob);
    assert(existsSync(keepObject), "referenced keep blob is missing after install");
    assert(existsSync(goneObject), "gone blob is missing after install");

    expectSuccess(await runTret(ctx.home, ["uninstall", "gctool-gone", "--yes"], binary), "uninstall gctool-gone");
    assertEqual(readFileSync(join(ctx.home, ".config", "gconetool", "gone.conf"), "utf8"), "gone-original\n", "restored gone.conf");
    assert(existsSync(goneObject), "uninstall immediately reclaimed a fresh blob inside the grace window");

    const past = new Date(Date.now() - 3_600_000);
    utimesSync(goneObject, past, past);
    utimesSync(keepObject, past, past);

    // A later record mutation runs GC. The keep record still references its blob; the aged orphan
    // from the uninstalled tool must be reclaimed.
    expectSuccess(await runTret(ctx.home, ["install", triggerUrl], binary), "install gctrigger");
    expectSuccess(await runTret(ctx.home, ["uninstall", "gctrigger", "--yes"], binary), "uninstall gctrigger");

    assert(!existsSync(goneObject), "aged unreferenced blob was not reclaimed after a later command");
    assert(existsSync(keepObject), "GC reclaimed a blob still referenced by a record");
    assertEqual(readFileSync(join(ctx.home, ".config", "gctool", "keep.conf"), "utf8"), "keep-new\n", "keep.conf before uninstall");

    expectSuccess(await runTret(ctx.home, ["uninstall", "gctool-keep", "--yes"], binary), "uninstall gctool-keep");
    assertEqual(readFileSync(join(ctx.home, ".config", "gctool", "keep.conf"), "utf8"), "keep-original\n", "restored keep.conf");
    assertEqual(readRecords(ctx.home).length, 0, "records after backup uninstalls");
  } finally {
    server.stop();
  }
}

/** `--version`, help, and piped human `list` write to stdout; JSON still parses on its own. */
async function scenarioInformationalOutput(binary: string): Promise<void> {
  const ctx = contextFor("info-output");
  const server = FixtureServer.start();
  try {
    const url = server.add("/install.sh", PROBE_INSTALLER);
    expectSuccess(await runTret(ctx.home, ["install", url], binary), "install probe");

    const version = await runTret(ctx.home, ["--version"], binary);
    expectSuccess(version, "--version");
    assert(version.stdout.trim() !== "", "--version wrote nothing to stdout");
    excludes(version.stdout, "Usage", "--version output");

    const help = await runTret(ctx.home, ["--help"], binary);
    expectSuccess(help, "--help");
    includes(help.stdout, "Usage", "--help stdout");
    includes(help.stdout, "Commands", "--help stdout");

    const listed = await runTret(ctx.home, ["list"], binary);
    expectSuccess(listed, "list");
    includes(listed.stdout, "Name", "piped human list stdout");
    includes(listed.stdout, "probe", "piped human list stdout");

    const json = await runTret(ctx.home, ["list", "--json"], binary);
    expectSuccess(json, "list --json");
    const document = parseJson(json.stdout, "list --json");
    assertEqual(document.command, "list", "list --json command");
    const tools = document.tools;
    assert(Array.isArray(tools) && tools.length === 1, "list --json tools");
  } finally {
    server.stop();
  }
}

/** Runs the scenarios in reported-finding order and stops at the first product failure. */
const scenarios: { name: string; run: (binary: string) => Promise<void> }[] = [
  { name: "trace under stock Yama uses linux-heuristic exactly once", run: scenarioTraceYama },
  { name: "forced reinstall leaves unattributed shell configs alone", run: scenarioForcedShellCleanup },
  { name: "forced replacement keeps a shared parent's other file and record", run: scenarioSharedParentReplacement },
  { name: "global --json before the command emits one document", run: scenarioJsonBeforeCommand },
  { name: "bare update flags take the self-update path, not a selector", run: scenarioBareUpdateFlags },
  { name: "--no-capture install uninstalls its additions", run: scenarioNoCaptureUninstall },
  { name: "marked shared PATH line is cleaned once and unmarked survives", run: scenarioPathLineCleanup },
  { name: "fresh no-executable install keeps a removable partial record", run: scenarioNoExecutablePartialRecord },
  { name: "aged backup blobs are reclaimed but referenced ones survive", run: scenarioBackupBlobGc },
  { name: "version, help, and piped list write to stdout", run: scenarioInformationalOutput },
];

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.error(`linux-acceptance: FAIL: this check runs on Linux only (host is ${process.platform})`);
    process.exit(1);
  }

  const binary = resolveBinary();
  process.stdout.write(`linux-acceptance: testing ${binary}\n`);
  process.stdout.write(`linux-acceptance: real HOME snapshot source ${REAL_HOME} (read-only)\n`);

  const results: ScenarioResult[] = [];
  const before = hostSnapshot();
  let failure: ScenarioFailure | undefined;

  try {
    for (const scenario of scenarios) {
      process.stdout.write(`\n▶ ${scenario.name}\n`);
      try {
        await scenario.run(binary);
        results.push({ name: scenario.name, status: "pass" });
        process.stdout.write(`  ok\n`);
      } catch (error) {
        if (error instanceof SkipError) {
          results.push({ name: scenario.name, status: "skip", reason: error.message });
          process.stdout.write(`  skipped: ${error.message}\n`);
          if (STRICT) {
            failure = new ScenarioFailure(scenario.name, new Error(`skipped in strict mode: ${error.message}`));
            break;
          }
          continue;
        }
        failure = new ScenarioFailure(scenario.name, error);
        break;
      }
    }
  } finally {
    cleanup();
  }

  const after = hostSnapshot();
  const difference = describeSnapshotDifference(before, after);

  process.stdout.write("\nAcceptance summary\n");
  for (const result of results) {
    if (result.status === "pass") process.stdout.write(`  pass  ${result.name}\n`);
    else process.stdout.write(`  skip  ${result.name}: ${result.reason}\n`);
  }

  if (difference !== undefined) {
    process.stdout.write(`\nhost integrity: FAILED, real user state changed\n${difference}\n`);
  } else {
    process.stdout.write(
      `\nhost integrity: ${before.length} paths unchanged (real HOME configs, ~/.tret/records.json, and /etc/profile.d)\n`,
    );
  }

  if (failure !== undefined) {
    process.stderr.write(`\nlinux-acceptance: FAIL: ${failure.scenario}\n${failure.message}\n`);
    process.exit(1);
  }
  if (difference !== undefined) {
    process.stderr.write("\nlinux-acceptance: FAIL: the check modified real host state\n");
    process.exit(1);
  }

  const skipped = results.filter((result) => result.status === "skip").length;
  process.stdout.write(`\nlinux-acceptance: ${results.length - skipped} passed, ${skipped} skipped\n`);
}

await main();
