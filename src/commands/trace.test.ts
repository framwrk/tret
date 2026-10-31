import type { CaptureBackend, CaptureSession } from "../lib/capture/backend";
import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mergeTraceEffects, trace } from "./trace";
import { FakeCaptureBackend } from "../lib/capture/fake";
import { FileStorage } from "../lib/store";
import type { NormalizedEffects } from "../lib/capture/normalize";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { parentAttachRestricted } from "../lib/capture/linux/backend";
import { tmpdir } from "node:os";

// Cover for `tret trace` (plan 03 item 2). The merge is tested as a pure function: only what the
// trace demonstrably wrote may be added, an already-tracked path keeps the install's original
// evidence, and another record's claim is never taken away. The command is tested through the CLI
// for its selection and consent guards, and end to end against the real macOS heuristic backend:
// a trace segment must be appended and the paths the tool wrote must land in the record.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-trace-cli-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function runCliResult(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BUN, TRET, ...args], {
    env: { ...process.env, HOME: home },
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

function writeRecords(home: string, records: RecordV3[]): void {
  mkdirSync(join(home, ".tret"), { recursive: true });
  writeFileSync(join(home, ".tret", "records.json"), JSON.stringify({ version: 3, records }, null, 2));
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const h = (char: string): string => char.repeat(64);

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "/home/.local/bin/mytool",
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "macos-heuristic",
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

function effects(overrides: Partial<NormalizedEffects> = {}): NormalizedEffects {
  return { owned: [], mutated: [], deleted: [], diagnostics: [], ...overrides };
}

/** A record whose one existing entry is of `kind`, for the "already tracked" matrix. */
function recordWithExisting(kind: "owned" | "mutated" | "deleted", path: string): RecordV3 {
  const base = record();
  switch (kind) {
    case "owned":
      return { ...base, owned: [{ path, kind: "file", installedHash: h("e") }] };
    case "mutated":
      return { ...base, mutated: [{ path, installedHash: h("e") }] };
    case "deleted":
      return { ...base, deleted: [{ path }] };
  }
}

/** A trace effect whose one entry is of `kind`, at `path`. */
function effectsAt(kind: "owned" | "mutated" | "deleted", path: string): NormalizedEffects {
  switch (kind) {
    case "owned":
      return effects({ owned: [{ path, kind: "file", installedHash: h("t") }] });
    case "mutated":
      return effects({ mutated: [{ path, installedHash: h("t") }] });
    case "deleted":
      return effects({ deleted: [{ path }] });
  }
}

describe("mergeTraceEffects", () => {
  test("adds the paths the trace observed and preserves the install's entries", () => {
    const target = record({
      owned: [{ path: "/h/installed", kind: "file", installedHash: h("i") }],
    });
    const added = effects({
      owned: [{ path: "/h/new-binary", kind: "file", installedHash: h("a") }],
      mutated: [{ path: "/h/new-config", installedHash: h("b") }],
      deleted: [{ path: "/h/removed-old" }],
    });

    const result = mergeTraceEffects(target, added, [target]);

    expect(result.added).toEqual({ owned: added.owned, mutated: added.mutated, deleted: added.deleted });
    expect(result.skipped).toEqual([]);
    expect(result.record.owned).toEqual([...target.owned, ...added.owned]);
    expect(result.record.mutated).toEqual(added.mutated);
    expect(result.record.deleted).toEqual(added.deleted);
  });

  test("returns a new record without mutating the one it was given", () => {
    const target = record();
    const before = JSON.parse(JSON.stringify(target)) as unknown;

    const result = mergeTraceEffects(target, effects({ owned: [{ path: "/h/a", kind: "file" }] }), [target]);

    expect(result.record).not.toBe(target);
    expect(result.record.owned).not.toBe(target.owned);
    expect(JSON.parse(JSON.stringify(target))).toEqual(before);
  });

  test("adds nothing and changes nothing when the trace saw nothing", () => {
    const target = record({ owned: [{ path: "/h/installed", kind: "file", installedHash: h("i") }] });
    const result = mergeTraceEffects(target, effects(), [target]);

    expect(result.added).toEqual({ owned: [], mutated: [], deleted: [] });
    expect(result.skipped).toEqual([]);
    expect(result.record).toEqual(target);
  });

  // The documented contract is that a path the record already tracks — as owned, mutated, or
  // deleted — keeps the install's original, more specific evidence instead of being re-added.
  const kinds = ["owned", "mutated", "deleted"] as const;
  for (const existing of kinds) {
    for (const traced of kinds) {
      test(`a traced ${traced} path already recorded as ${existing} is skipped`, () => {
        const path = "/h/shared-path";
        const target = recordWithExisting(existing, path);
        const result = mergeTraceEffects(target, effectsAt(traced, path), [target]);

        expect(result.skipped).toEqual([{ path, reason: "already-tracked" }]);
        expect(result.added).toEqual({ owned: [], mutated: [], deleted: [] });
        expect(result.record).toEqual(target);
      });
    }
  }

  test("never takes a path another record already claims", () => {
    const other = record({
      id: "rec-other",
      name: "other-tool",
      owned: [{ path: "/h/claimed", kind: "file", installedHash: h("o") }],
    });
    const target = record();
    const result = mergeTraceEffects(
      target,
      effects({
        owned: [{ path: "/h/claimed", kind: "file" }],
        mutated: [{ path: "/h/claimed" }],
        deleted: [{ path: "/h/claimed" }],
      }),
      [target, other],
    );

    expect(result.skipped).toEqual([
      { path: "/h/claimed", reason: "claimed-by-other" },
      { path: "/h/claimed", reason: "claimed-by-other" },
      { path: "/h/claimed", reason: "claimed-by-other" },
    ]);
    expect(result.added).toEqual({ owned: [], mutated: [], deleted: [] });
    expect(result.record).toEqual(target);
  });

  test("another record's mutated or deleted path is a claim too", () => {
    for (const kind of ["mutated", "deleted"] as const) {
      const other = record({
        id: "rec-other",
        name: "other-tool",
        ...(kind === "mutated" ? { mutated: [{ path: "/h/claimed" }] } : { deleted: [{ path: "/h/claimed" }] }),
      });
      const result = mergeTraceEffects(record(), effects({ owned: [{ path: "/h/claimed", kind: "file" }] }), [other]);
      expect(result.skipped).toEqual([{ path: "/h/claimed", reason: "claimed-by-other" }]);
    }
  });

  test("case-variant paths count as one claim only where a record was case-insensitive", () => {
    const other = (caseSensitive: boolean) =>
      record({
        id: "rec-other",
        name: "other-tool",
        caseSensitive,
        owned: [{ path: "/h/Shared", kind: "file", installedHash: h("o") }],
      });
    const traced = (caseSensitive: boolean, otherCaseSensitive: boolean) =>
      mergeTraceEffects(record({ caseSensitive }), effects({ owned: [{ path: "/h/shared", kind: "file" }] }), [
        other(otherCaseSensitive),
      ]);

    // Both records are case-sensitive: two spellings are two files.
    const bothSensitive = traced(true, true);
    expect(bothSensitive.skipped).toEqual([]);
    expect(bothSensitive.added.owned).toHaveLength(1);

    // The other record was on a case-insensitive filesystem, so its spelling claims ours.
    expect(traced(true, false).skipped).toEqual([{ path: "/h/shared", reason: "claimed-by-other" }]);

    // Our record is case-insensitive, so any other record's spelling claims ours.
    expect(traced(false, true).skipped).toEqual([{ path: "/h/shared", reason: "claimed-by-other" }]);
  });

  test("duplicate paths inside one trace are added once", () => {
    const target = record();
    const result = mergeTraceEffects(
      target,
      effects({
        owned: [
          { path: "/h/a", kind: "file", installedHash: h("a") },
          { path: "/h/a", kind: "file", installedHash: h("a") },
        ],
      }),
      [target],
    );

    expect(result.added.owned).toHaveLength(1);
    expect(result.skipped).toEqual([{ path: "/h/a", reason: "already-tracked" }]);
  });

  test("reports skips in the order the effects were observed", () => {
    const target = record({ owned: [{ path: "/h/a", kind: "file", installedHash: h("a") }] });
    const result = mergeTraceEffects(
      target,
      effects({
        owned: [{ path: "/h/a", kind: "file" }],
        mutated: [{ path: "/h/b" }, { path: "/h/c" }],
        deleted: [{ path: "/h/b" }],
      }),
      [target],
    );

    // `/h/b` is added as a mutation, so the later deletion of it is a duplicate, not a new claim.
    expect(result.skipped).toEqual([
      { path: "/h/a", reason: "already-tracked" },
      { path: "/h/b", reason: "already-tracked" },
    ]);
    expect(result.added.mutated.map((entry) => entry.path)).toEqual(["/h/b", "/h/c"]);
  });
});

describe("trace CLI", () => {
  test("requires a tool name or record id", async () => {
    expect((await runCliResult(["trace"], makeHome())).code).toBe(EXIT_USAGE);
    expect((await runCliResult(["trace", "--yes"], makeHome())).code).toBe(EXIT_USAGE);
  });

  test("an unknown tool exits with the not-found code without running anything", async () => {
    const home = makeHome();
    const sentinel = join(home, "ran");
    const runner = join(home, "runner.sh");
    writeFileSync(runner, `#!/bin/sh\nprintf 'ran' > "${sentinel}"\n`);
    writeRecords(home, [record({ name: "runner", executable: runner })]);

    const result = await runCliResult(["trace", "nope", "--yes"], home);

    expect(result.code).toBe(EXIT_NOT_FOUND);
    // Selection failed before the observed window: the tracked tool was never executed.
    expect(existsSync(sentinel)).toBe(false);
  });

  test("a shared name is ambiguous and exits with the ambiguous code", async () => {
    const home = makeHome();
    writeRecords(home, [record({ id: "rec-a", name: "dup" }), record({ id: "rec-b", name: "dup" })]);
    expect((await runCliResult(["trace", "dup", "--json"], home)).code).toBe(EXIT_AMBIGUOUS);

    const result = await runCliResult(["trace", "dup", "--json"], home);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: "trace-ambiguous",
        message: "2 tracked installs are named dup; select one by record id",
      },
    });
  });

  test("a record with no tracked executable cannot be traced", async () => {
    const home = makeHome();
    writeRecords(home, [record({ executable: "" })]);

    const human = await runCliResult(["trace", "mytool", "--yes"], home);
    expect(human.code).toBe(EXIT_USAGE);
    expect(`${human.stdout}\n${human.stderr}`).toContain("no tracked executable to run");

    const json = await runCliResult(["trace", "mytool", "--json"], home);
    expect(json.code).toBe(EXIT_USAGE);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: { code: "trace-executable", message: "mytool has no tracked executable to run" },
    });
  });

  test("refuses to run the tool without --yes when it cannot ask", async () => {
    const home = makeHome();
    const sentinel = join(home, "ran");
    const runner = join(home, "runner.sh");
    writeFileSync(runner, `#!/bin/sh\nprintf 'ran' > "${sentinel}"\n`);
    writeRecords(home, [record({ name: "runner", executable: runner })]);

    const json = await runCliResult(["trace", "runner", "--json"], home);
    expect(json.code).toBe(EXIT_BLOCKED);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: { code: "trace-consent", message: "pass --yes to trace without a prompt in JSON mode" },
    });

    // This CLI helper runs without a terminal, so the human path refuses for the same reason.
    const human = await runCliResult(["trace", "runner"], home);
    expect(human.code).toBe(EXIT_BLOCKED);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("JSON mode reports a missing tool as a structured error", async () => {
    const home = makeHome();
    writeRecords(home, [record()]);
    const result = await runCliResult(["trace", "nope", "--json"], home);

    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "trace-not-found", message: "no tracked install matches nope" },
    });
  });
});

/** A primary tracer that refuses to attach, like strace under Yama `ptrace_scope=1`. */
class ThrowingStartBackend implements CaptureBackend {
  readonly name: string;
  readonly completeness = "complete" as const;
  starts = 0;

  constructor(name = "linux-strace") {
    this.name = name;
  }

  async start(): Promise<CaptureSession> {
    this.starts += 1;
    throw new Error("strace could not attach: Operation not permitted");
  }
}

describe("trace capture fallback", () => {
  test("an injected attach failure runs the tool exactly once under the heuristic window", async () => {
    const home = makeHome();
    const scope = join(home, "scope");
    mkdirSync(scope, { recursive: true });
    const storage = new FileStorage({ homeDir: home });
    writeRecords(home, [record({ executable: join(home, "bin", "mytool") })]);
    const primary = new ThrowingStartBackend();
    let runs = 0;

    await trace("mytool", true, {
      storage,
      roots: [scope],
      backend: primary,
      run: async () => {
        runs += 1;
        writeFileSync(join(scope, "created.txt"), "hello");
        writeFileSync(join(home, "outside.txt"), "not in scope");
        return 0;
      },
    });

    expect(primary.starts).toBe(1);
    expect(runs).toBe(1);

    const saved = (await storage.loadRecords())[0]!;
    expect(saved.capture.segments.map((segment) => segment.kind)).toEqual(["install", "trace"]);
    expect(saved.owned.some((entry) => entry.path === join(scope, "created.txt"))).toBe(true);
    expect(
      [...saved.owned, ...saved.mutated, ...saved.deleted].some((entry) => entry.path === join(home, "outside.txt")),
    ).toBe(false);
  });

  test("a started primary that reports partial coverage does not rerun the tool", async () => {
    const home = makeHome();
    const scope = join(home, "scope");
    mkdirSync(scope, { recursive: true });
    const storage = new FileStorage({ homeDir: home });
    writeRecords(home, [record({ executable: join(home, "bin", "mytool") })]);
    const primary = new FakeCaptureBackend({
      name: "linux-fanotify",
      completeness: "partial",
      partialReason: "dropped a directory-entry event",
    });
    const fallback = new ThrowingStartBackend("linux-heuristic");
    let runs = 0;

    await trace("mytool", true, {
      storage,
      roots: [scope],
      backend: primary,
      fallbackBackend: fallback,
      run: async () => {
        runs += 1;
        return 0;
      },
    });

    expect(runs).toBe(1);
    expect(fallback.starts).toBe(0);
    const saved = (await storage.loadRecords())[0]!;
    expect(saved.capture.segments).toHaveLength(2);
    expect(saved.capture.segments[1]?.partialReason).toContain("directory-entry");
  });
});

describe.skipIf(process.platform !== "linux")("trace CLI on the host tracer", () => {
  test("traces under the available backend and reports linux-heuristic when Yama blocks attach", async () => {
    const home = makeHome();
    const sentinel = join(home, "ran.log");
    const runner = join(home, "runner.sh");
    writeFileSync(runner, `#!/bin/sh\nprintf 'ran\\n' >> "${sentinel}"\n`);
    chmodSync(runner, 0o755);
    writeRecords(home, [record({ name: "runner", executable: runner })]);

    const result = await runCliResult(["trace", "runner", "--yes", "--json"], home);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { ok: boolean; backend: string; completeness: string };
    expect(output.ok).toBe(true);

    if (parentAttachRestricted()) {
      expect(output.backend).toBe("linux-heuristic");
      expect(output.completeness).toBe("heuristic");
    } else {
      expect(["linux-strace", "linux-fanotify", "linux-heuristic"]).toContain(output.backend);
    }

    // The observed work ran once no matter which backend won the pre-run selection.
    expect(readFileSync(sentinel, "utf8").trim().split("\n")).toEqual(["ran"]);
  });
});

// The real capture backend is only guaranteed to attach the same way on the platform it belongs
// to; the Linux backend has its own integration and smoke coverage in `src/lib/capture/linux`.
describe.skipIf(process.platform !== "darwin")("trace command (macOS heuristic capture)", () => {
  test("appends a trace segment and merges the paths the tool wrote", async () => {
    const home = makeHome();
    const scope = join(home, "scope");
    mkdirSync(scope, { recursive: true });
    const installed = join(scope, "already-owned.txt");
    writeFileSync(installed, "installed");
    writeRecords(home, [
      record({
        executable: join(home, "bin", "mytool"),
        owned: [{ path: installed, kind: "file", installedHash: sha256("installed") }],
      }),
    ]);

    let ran = false;
    const storage = new FileStorage({ homeDir: home });
    await trace("mytool", true, {
      storage,
      roots: [scope],
      run: async () => {
        ran = true;
        writeFileSync(join(scope, "created.txt"), "hello");
        // Writing over an owned path must not replace the install's recorded evidence.
        writeFileSync(installed, "rewritten by the trace");
        return 0;
      },
    });

    expect(ran).toBe(true);

    const saved = (await storage.loadRecords())[0]!;
    expect(saved.id).toBe("rec-1");
    // The install window is untouched; the trace window is recorded next to it.
    expect(saved.capture.segments.map((segment) => segment.kind)).toEqual(["install", "trace"]);
    expect(saved.capture.segments[0]).toEqual({ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" });
    expect(typeof saved.capture.segments[1]?.startedAt).toBe("string");
    expect(typeof saved.capture.segments[1]?.endedAt).toBe("string");
    expect(saved.capture.backend).toBe("macos-heuristic");
    expect(saved.capture.completeness).toBe("heuristic");

    const created = saved.owned.find((entry) => entry.path === join(scope, "created.txt"));
    expect(created?.kind).toBe("file");
    expect(created?.installedHash).toBe(sha256("hello"));
    // The pre-existing owned entry keeps its installed fingerprint and is not duplicated.
    expect(saved.owned.filter((entry) => entry.path === installed)).toHaveLength(1);
    expect(saved.owned.find((entry) => entry.path === installed)?.installedHash).toBe(sha256("installed"));
  });
});
