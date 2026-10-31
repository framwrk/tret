#!/usr/bin/env bun
/**
 * Gated real production-attach check for the Linux `linux-strace` backend (plan V4).
 *
 * It drives the *shipped* `tret` binary through the same parent-attach flow production uses:
 *
 *   1. `tret install <loopback-url>` runs a local fixture installer in a temporary HOME while the
 *      tracer attaches to Tret itself, then asserts through `tret inspect --json` that the saved
 *      record's `capture.backend` is `linux-strace`. Completeness and any partial reason are printed.
 *   2. `tret trace <tool> --json` runs the installed fixture tool once in a second window, asserts
 *      the window used `linux-strace`, and asserts the record gained exactly one `trace` segment.
 *      A run counter proves the tool executed exactly once (no rerun after a failed attach).
 *
 * Prerequisites: Linux, a non-root user, `strace` on PATH, and Yama
 * `/proc/sys/kernel/yama/ptrace_scope` = 0 so an unprivileged tracer may attach to its parent.
 *
 * The check never changes a sysctl, never escalates, and never writes outside its temporary HOME.
 * When a prerequisite is missing it prints a precise skip and exits 0; set TRET_REQUIRE_STRACE=1 to
 * turn that skip into a failure. The real `~/.tret/records.json` and `~/.bashrc` are hashed before
 * and after and must be byte-for-byte unchanged.
 *
 * Usage:
 *   bun scripts/linux-strace-e2e.ts                          # uses dist/tret-linux-<arch>
 *   TRET_BIN=/path/to/tret bun scripts/linux-strace-e2e.ts
 *   TRET_REQUIRE_STRACE=1 bun scripts/linux-strace-e2e.ts    # a skip is an error
 */

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PTRACE_SCOPE = "/proc/sys/kernel/yama/ptrace_scope";
const REQUIRE = Bun.env.TRET_REQUIRE_STRACE === "1";
const TOOL = "tret-strace-e2e";
const RUN_LOG = ".tret-strace-e2e-runs";

/** A `tret install --json` document (the fields this check reads). */
type InstallDocument = {
  ok: boolean;
  tool: string;
  id: string;
  capture: { backend: string; completeness: string };
};

/** One capture segment as `tret inspect --json` and `tret trace --json` report it. */
type SegmentDocument = { kind: string; startedAt: string; endedAt?: string; partialReason?: string };

/** The `tret inspect --json` document (the fields this check reads). */
type InspectDocument = {
  name: string;
  capture: { backend: string; completeness: string; segments: SegmentDocument[] };
};

/** A `tret trace --json` document. */
type TraceDocument = {
  ok: boolean;
  backend: string;
  completeness: string;
  exitCode: number;
  segment: SegmentDocument;
};

type RunResult = { code: number; stdout: string; stderr: string };

/** Prints a gated skip and ends the run; with TRET_REQUIRE_STRACE=1 the skip is a failure. */
function skip(reason: string): never {
  if (REQUIRE) {
    console.error(`linux-strace-e2e: FAIL: ${reason} (TRET_REQUIRE_STRACE=1 makes this an error)`);
    process.exit(1);
  }
  console.log(`linux-strace-e2e: skipped: ${reason}`);
  process.exit(0);
}

/** Reports a failed assertion; the top-level handler prints it after the cleanup in `main`. */
function fail(message: string): never {
  throw new Error(message);
}

/** Runs one command with the temporary HOME and keeps both output streams. */
async function run(argv: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Parses one JSON document a `tret` run printed; anything else is a failure with the raw output. */
function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fail(`could not parse ${what} JSON output: ${raw.slice(0, 400)}`);
  }
}

/** One-line evidence line: backend, completeness, and every partial reason the window reported. */
function printCapture(label: string, capture: { backend: string; completeness: string }, segments: SegmentDocument[]): void {
  const reasons = segments.map((segment) => segment.partialReason).filter((reason) => reason !== undefined);
  console.log(
    `linux-strace-e2e: ${label} backend=${capture.backend} completeness=${capture.completeness} partialReason=${
      reasons.length === 0 ? "none" : reasons.join("; ")
    }`,
  );
}

/** The sha256 of a file, or "absent" when it does not exist. Reads only; never writes. */
async function fileHash(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "absent";
  return new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex");
}

/** Number of lines the fixture tool appended; 0 when it never ran. */
async function runCount(path: string): Promise<number> {
  const file = Bun.file(path);
  if (!(await file.exists())) return 0;
  const text = await file.text();
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

/** The release binary this check drives, from TRET_BIN or dist/tret-linux-<arch>. */
async function resolveBinary(): Promise<string> {
  const override = Bun.env.TRET_BIN;
  if (override !== undefined && override !== "") {
    const info = await stat(override).catch(() => undefined);
    if (info === undefined || !info.isFile() || (info.mode & 0o111) === 0) {
      fail(`TRET_BIN=${override} is not an executable file`);
    }
    return override;
  }
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (arch === undefined) skip(`unsupported architecture: ${process.arch}`);
  const bin = join(import.meta.dir, "..", "dist", `tret-linux-${arch}`);
  const info = await stat(bin).catch(() => undefined);
  if (info === undefined || !info.isFile() || (info.mode & 0o111) === 0) {
    fail(`missing ${bin}; run 'bash scripts/build.sh linux-${arch}' first or set TRET_BIN`);
  }
  return bin;
}

/** Reads the Yama scope; `undefined` means the file is absent (Yama not active). */
async function readPtraceScope(): Promise<string | undefined> {
  // procfs reports a size of 0, so Bun.file().text() would read it as empty; readFile reads the file.
  try {
    return (await readFile(PTRACE_SCOPE, "utf8")).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The fixture installer: writes one executable tool whose runs it counts in the temporary HOME. */
const INSTALLER = `#!/bin/sh
set -eu
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/tret-strace-e2e-tool" <<'TOOL'
#!/bin/sh
printf 'run\\n' >> "$HOME/${RUN_LOG}"
TOOL
chmod 755 "$HOME/.local/bin/tret-strace-e2e-tool"
`;

async function main(): Promise<void> {
  if (process.platform !== "linux") skip(`not a Linux host (this check needs Linux parent attach)`);

  const scope = await readPtraceScope();
  if (scope !== undefined && Number(scope) >= 1) {
    skip(
      `Yama ${PTRACE_SCOPE} is ${scope} (not 0), so an unprivileged tracer may not attach to its parent. ` +
        `Run this on a disposable host whose operator has already set it to 0; this check never changes sysctl values.`,
    );
  }
  if (scope === undefined) {
    console.log(`linux-strace-e2e: ${PTRACE_SCOPE} is absent; Yama does not restrict parent attach`);
  }
  if (process.getuid?.() === 0) {
    skip(`running as root; this check exercises the unprivileged parent-attach path`);
  }
  if (Bun.which("strace") === null) {
    skip(
      `strace is not on PATH; the linux-strace backend cannot start. Install strace (>= 6.5 for the full trace set) and retry`,
    );
  }

  const bin = await resolveBinary();

  // Hash the real user state this check must never touch. The child runs below get a temporary HOME;
  // these files are only read here and compared again after every `tret` run.
  const realHome = Bun.env.HOME;
  const realRecords = realHome === undefined ? undefined : join(realHome, ".tret", "records.json");
  const realBashrc = realHome === undefined ? undefined : join(realHome, ".bashrc");
  const recordsBefore = realRecords === undefined ? "absent" : await fileHash(realRecords);
  const bashrcBefore = realBashrc === undefined ? "absent" : await fileHash(realBashrc);

  const work = await mkdtemp(join(tmpdir(), "tret-strace-e2e-"));
  const home = join(work, "home");
  await mkdir(home, { recursive: true });
  const runs = join(home, RUN_LOG);
  const env = { ...process.env, HOME: home };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(INSTALLER, { headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
  const url = `http://127.0.0.1:${server.port}/install.sh`;

  try {
    console.log(`linux-strace-e2e: using ${bin}`);

    // 1/4: production install with a real parent attach.
    console.log("linux-strace-e2e: 1/4 installing the loopback fixture with the production window");
    const install = await run([bin, "install", url, "--name", TOOL, "--yes", "--json"], env);
    if (install.code !== 0) {
      fail(`tret install exited ${install.code}\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
    }
    const installed = parseJson<InstallDocument>(install.stdout, "install");
    if (installed.ok !== true) fail("tret install did not report success");
    if (installed.capture.backend !== "linux-strace") {
      fail(`install selected ${installed.capture.backend}, expected linux-strace under ptrace_scope=0`);
    }

    // The saved record, not the transient command output, is the assertion that matters.
    console.log("linux-strace-e2e: 2/4 inspecting the saved record");
    const inspectBefore = await run([bin, "inspect", installed.tool, "--json"], env);
    if (inspectBefore.code !== 0) {
      fail(`tret inspect exited ${inspectBefore.code}\nstdout:\n${inspectBefore.stdout}\nstderr:\n${inspectBefore.stderr}`);
    }
    const record = parseJson<InspectDocument>(inspectBefore.stdout, "inspect");
    if (record.capture.backend !== "linux-strace") {
      fail(`the saved record's capture.backend is ${record.capture.backend}, expected linux-strace`);
    }
    const installSegments = record.capture.segments.filter((segment) => segment.kind === "install");
    if (installSegments.length !== 1) {
      fail(`the saved record has ${installSegments.length} install segments, expected exactly one`);
    }
    printCapture("install", record.capture, record.capture.segments);
    if ((await runCount(runs)) !== 0) fail("the fixture tool ran during install");

    // 3/4: explicit trace window; the tool must run once and append one segment.
    console.log("linux-strace-e2e: 3/4 tracing the installed tool once");
    const trace = await run([bin, "trace", installed.tool, "--yes", "--json"], env);
    if (trace.code !== 0) {
      fail(`tret trace exited ${trace.code}\nstdout:\n${trace.stdout}\nstderr:\n${trace.stderr}`);
    }
    const traced = parseJson<TraceDocument>(trace.stdout, "trace");
    if (traced.ok !== true) fail("tret trace did not report success");
    if (traced.backend !== "linux-strace") fail(`trace selected ${traced.backend}, expected linux-strace`);
    if (traced.segment.kind !== "trace") fail(`the appended segment is ${traced.segment.kind}, expected trace`);
    printCapture("trace", traced, [traced.segment]);

    // 4/4: the record gained exactly one trace segment, and the tool did not run twice.
    console.log("linux-strace-e2e: 4/4 checking the appended segment and the single tool run");
    const inspectAfter = await run([bin, "inspect", installed.tool, "--json"], env);
    if (inspectAfter.code !== 0) {
      fail(`tret inspect exited ${inspectAfter.code}\nstdout:\n${inspectAfter.stdout}\nstderr:\n${inspectAfter.stderr}`);
    }
    const updated = parseJson<InspectDocument>(inspectAfter.stdout, "inspect");
    const traceSegments = updated.capture.segments.filter((segment) => segment.kind === "trace");
    if (traceSegments.length !== 1) {
      fail(`the record has ${traceSegments.length} trace segments, expected exactly one`);
    }
    if (updated.capture.segments.length !== 2) {
      fail(`the record has ${updated.capture.segments.length} segments, expected install + one trace`);
    }
    if (updated.capture.backend !== "linux-strace") {
      fail(`the record's capture.backend changed to ${updated.capture.backend}`);
    }
    printCapture("record", updated.capture, updated.capture.segments);
    const executions = await runCount(runs);
    if (executions !== 1) fail(`the fixture tool ran ${executions} times, expected exactly once (no rerun)`);

    if (realRecords !== undefined && (await fileHash(realRecords)) !== recordsBefore) {
      fail(`the check changed the real ${realRecords}`);
    }
    if (realBashrc !== undefined && (await fileHash(realBashrc)) !== bashrcBefore) {
      fail(`the check changed the real ${realBashrc}`);
    }
    console.log(
      `linux-strace-e2e: real ${realRecords ?? "~/.tret/records.json"} and ${realBashrc ?? "~/.bashrc"} are unchanged`,
    );
    console.log("linux-strace-e2e: passed");
  } finally {
    await server.stop(true);
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`linux-strace-e2e: FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
