import { EXIT_AMBIGUOUS, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import type { InspectAction, InspectReport } from "./inspect";
import type { UninstallPlan, UninstallPlanner, UninstallVerification } from "../lib/uninstall-planner";
import { afterEach, describe, expect, test } from "bun:test";
import { buildInspectReport, formatInspect } from "./inspect";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Cover for `tret inspect` (plan 03 item 1). Two layers: the pure report/formatting logic against
// injected disk state, and the command itself through the CLI so its exit codes, JSON document, and
// read-only promise are checked end to end. The read-only promise is asserted literally: the
// records file and the tracked files are byte-identical after a run.

const BUN = process.execPath;
const TRET = join(import.meta.dir, "..", "..", "index.ts");

const homes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tret-inspect-cli-"));
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

function readRecordsRaw(home: string): string {
  return readFileSync(join(home, ".tret", "records.json"), "utf8");
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

/** A verification map keyed by path; anything unlisted is absent, as on a real disk. */
function states(map: Record<string, UninstallVerification>): (path: string) => UninstallVerification {
  return (path) => map[path] ?? { exists: false };
}

/** A planner that returns a fixed plan, for pinning the report's action mapping. */
function fixedPlanner(plan: UninstallPlan, seen: { record?: RecordV3; delegatedRoots?: string[] } = {}): UninstallPlanner {
  return {
    async plan(target, context) {
      seen.record = target;
      seen.delegatedRoots = context?.delegatedRoots;
      return plan;
    },
  };
}

function plan(overrides: Partial<UninstallPlan> = {}): UninstallPlan {
  return {
    recordId: "rec-1",
    tool: "mytool",
    actions: [],
    confidence: "observed",
    requiresSudo: false,
    incomplete: false,
    ...overrides,
  };
}

describe("buildInspectReport", () => {
  test("reports the record's identity, capture evidence, and derived confidence", async () => {
    const target = record();
    const report = await buildInspectReport(target, [target], {
      inspect: states({}),
      home: "/home/test",
      executableExists: () => true,
    });

    expect(report).toMatchObject({
      id: "rec-1",
      name: "mytool",
      source: "install",
      url: "https://example.com/install.sh",
      installedAt: "2026-10-09T00:00:00.000Z",
      executable: "/home/.local/bin/mytool",
      state: "installed",
      privilege: "user",
      caseSensitive: true,
      capture: {
        backend: "macos-heuristic",
        completeness: "heuristic",
        confidence: "observed",
        segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
      },
    });
  });

  test("a complete capture is reported as proven, a partial one as observed", async () => {
    for (const [completeness, confidence] of [
      ["complete", "proven"],
      ["partial", "observed"],
      ["heuristic", "observed"],
    ] as const) {
      const target = record({ capture: { backend: "linux-strace", completeness, segments: [] } });
      const report = await buildInspectReport(target, [target], {
        inspect: states({}),
        home: "/home/test",
        executableExists: () => true,
      });
      expect(report.capture.completeness).toBe(completeness);
      expect(report.capture.confidence).toBe(confidence);
    }
  });

  test("an absent executable makes the record partial, and a record with none is always partial", async () => {
    const present = record();
    expect(
      (await buildInspectReport(present, [present], { inspect: states({}), home: "/home/test", executableExists: () => true }))
        .state,
    ).toBe("installed");
    expect(
      (await buildInspectReport(present, [present], { inspect: states({}), home: "/home/test", executableExists: () => false }))
        .state,
    ).toBe("partial");

    const unattached = record({ executable: "" });
    expect(
      (
        await buildInspectReport(unattached, [unattached], {
          inspect: states({}),
          home: "/home/test",
          executableExists: () => true,
        })
      ).state,
    ).toBe("partial");
  });

  test("owned entries compare the installed fingerprint with what is on disk", async () => {
    const target = record({
      owned: [
        { path: "/h/matches", kind: "file", installedHash: h("a") },
        { path: "/h/changed", kind: "file", installedHash: h("b") },
        { path: "/h/no-hash", kind: "directory" },
        { path: "/h/absent", kind: "file", installedHash: h("c") },
      ],
    });
    const report = await buildInspectReport(target, [target], {
      inspect: states({
        "/h/matches": { exists: true, kind: "file", hash: h("a") },
        "/h/changed": { exists: true, kind: "file", hash: h("d") },
        "/h/no-hash": { exists: true, kind: "directory" },
      }),
      home: "/home/test",
      executableExists: () => true,
    });

    expect(report.owned).toEqual([
      { path: "/h/matches", kind: "file", exists: true, matchesInstalled: true },
      { path: "/h/changed", kind: "file", exists: true, matchesInstalled: false },
      // No recorded fingerprint: nothing to compare, so the key is absent rather than a guess.
      { path: "/h/no-hash", kind: "directory", exists: true },
      { path: "/h/absent", kind: "file", exists: false },
    ]);
  });

  test("mutated and deleted entries report restorability and whether they changed since install", async () => {
    const target = record({
      mutated: [
        { path: "/h/m-unchanged", beforeBlob: h("1"), installedHash: h("m") },
        { path: "/h/m-diverged", beforeBlob: h("2"), installedHash: h("m") },
        { path: "/h/m-gone", installedHash: h("m") },
        { path: "/h/m-no-hash" },
      ],
      deleted: [{ path: "/h/d-still-gone", beforeBlob: h("3") }, { path: "/h/d-recreated" }],
    });
    const report = await buildInspectReport(target, [target], {
      inspect: states({
        "/h/m-unchanged": { exists: true, kind: "file", hash: h("m") },
        "/h/m-diverged": { exists: true, kind: "file", hash: h("z") },
        "/h/m-no-hash": { exists: true, kind: "file", hash: h("y") },
        "/h/d-recreated": { exists: true, kind: "file", hash: h("r") },
      }),
      home: "/home/test",
      executableExists: () => true,
    });

    expect(report.mutated).toEqual([
      { path: "/h/m-unchanged", exists: true, restorable: true, changedSinceInstall: false },
      { path: "/h/m-diverged", exists: true, restorable: true, changedSinceInstall: true },
      { path: "/h/m-gone", exists: false, restorable: false, changedSinceInstall: true },
      // Present with no recorded installed hash and no before-image: nothing proves a change.
      { path: "/h/m-no-hash", exists: true, restorable: false, changedSinceInstall: false },
    ]);
    expect(report.deleted).toEqual([
      { path: "/h/d-still-gone", exists: false, restorable: true, changedSinceInstall: false },
      // A path recorded as deleted that exists again was recreated after the install.
      { path: "/h/d-recreated", exists: true, restorable: false, changedSinceInstall: true },
    ]);
  });

  test("maps every planner action into the report's JSON-safe shape", async () => {
    const planner = fixedPlanner(
      plan({
        requiresSudo: true,
        incomplete: true,
        actions: [
          { action: "remove", path: "/p/remove", kind: "file", plannedState: { exists: true, hash: h("a") } },
          {
            action: "restore",
            path: "/p/restore",
            kind: "file",
            beforeBlob: h("b"),
            mode: 0o600,
            plannedState: { exists: true, hash: h("c") },
          },
          { action: "skip", path: "/p/skip", reason: "absent" },
          { action: "detected", path: "/p/detected", kind: "mutated" },
          { action: "conflict", path: "/p/conflict", reason: "modified" },
        ],
      }),
    );
    const target = record();
    const report = await buildInspectReport(target, [target], {
      planner,
      inspect: states({}),
      home: "/home/test",
      executableExists: () => true,
    });

    // `plannedState`, `beforeBlob`, and `mode` are plan-time guards, not report data.
    expect(report.actions).toEqual([
      { path: "/p/remove", action: "remove", kind: "file" },
      { path: "/p/restore", action: "restore", kind: "file" },
      { path: "/p/skip", action: "skip", reason: "absent" },
      { path: "/p/detected", action: "detected", kind: "mutated" },
      { path: "/p/conflict", action: "conflict", reason: "modified" },
    ]);
    expect(report.requiresSudo).toBe(true);
    expect(report.incomplete).toBe(true);
    expect(report.counts).toEqual({ owned: 0, mutated: 0, deleted: 0, removable: 1, restorable: 1 });
  });

  test("passes the record's delegated managed-install root to the planner", async () => {
    const seen: { delegatedRoots?: string[] } = {};
    const target = record({
      managedInstall: { kind: "pi-managed-install", layout: "releases-v1", root: "/home/test/.pi/install" },
    });
    await buildInspectReport(target, [target], {
      planner: fixedPlanner(plan(), seen),
      inspect: states({}),
      home: "/home/test",
      executableExists: () => true,
    });
    expect(seen.delegatedRoots).toEqual(["/home/test/.pi/install"]);
  });

  test("a managed package's shared global state is left out of the owned paths", async () => {
    const shim = "/home/test/.bun/bin/acmetool";
    const shared = "/home/test/.bun/install/global/node_modules/@acme/tool/cli.js";
    const target = record({
      name: "acmetool",
      executable: shim,
      owned: [
        { path: shim, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" },
        { path: shared, kind: "file", installedHash: h("a") },
      ],
      managedBy: { manager: "bun", package: "@acme/tool" },
    });
    const report = await buildInspectReport(target, [target], {
      inspect: states({
        [shim]: { exists: true, kind: "symlink", linkTarget: "../install/global/node_modules/@acme/tool/cli.js" },
      }),
      home: "/home/test",
      executableExists: () => true,
    });

    expect(report.owned.map((entry) => entry.path)).toEqual([shim]);
    expect(report.delegated.managedBy).toEqual({ manager: "bun", package: "@acme/tool" });
    expect(report.owned.some((entry) => entry.path === shared)).toBe(false);
  });

  test("reports a managed install's layout and root", async () => {
    const target = record({
      managedInstall: { kind: "pi-managed-install", layout: "releases-v1", root: "/home/test/.pi/install" },
    });
    const report = await buildInspectReport(target, [target], {
      inspect: states({}),
      home: "/home/test",
      executableExists: () => true,
    });
    expect(report.delegated.managedInstall).toEqual({
      kind: "pi-managed-install",
      layout: "releases-v1",
      root: "/home/test/.pi/install",
    });
  });

  test("surfaces a delegated removal that overlaps another record's claim", async () => {
    const target = record({
      name: "acmetool",
      executable: "/home/test/.bun/bin/acmetool",
      managedBy: { manager: "bun", package: "@acme/tool" },
    });
    const other = record({
      id: "rec-other",
      name: "other-tool",
      executable: "/home/test/bin/other",
      owned: [
        {
          path: "/home/test/.bun/install/global/node_modules/@acme/tool/nested/owned.txt",
          kind: "file",
          installedHash: h("o"),
        },
      ],
    });
    const report = await buildInspectReport(target, [target, other], {
      inspect: states({}),
      home: "/home/test",
      executableExists: () => true,
    });

    const scope = "/home/test/.bun/install/global/node_modules/@acme/tool";
    expect(report.delegated.conflicts).toEqual([
      `conflict: delegated removal of ${scope} overlaps ${scope}/nested/owned.txt, claimed by other-tool`,
    ]);
  });

  test("does not modify the record or the records list it is given", async () => {
    const target = record({
      owned: [{ path: "/h/owned", kind: "file", installedHash: h("a") }],
      mutated: [{ path: "/h/mutated", beforeBlob: h("b"), installedHash: h("c") }],
      deleted: [{ path: "/h/deleted" }],
    });
    const records = [target];
    const before = JSON.parse(JSON.stringify({ record: target, records })) as unknown;

    await buildInspectReport(target, records, {
      inspect: states({ "/h/owned": { exists: true, kind: "file", hash: h("a") } }),
      home: "/home/test",
      executableExists: () => true,
    });

    expect(JSON.parse(JSON.stringify({ record: target, records }))).toEqual(before);
  });
});

/** A complete report for formatting tests; overrides replace whole nested values. */
function sampleReport(overrides: Partial<InspectReport> = {}): InspectReport {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: "/home/.local/bin/mytool",
    state: "installed",
    privilege: "user",
    caseSensitive: true,
    capture: {
      backend: "macos-heuristic",
      completeness: "heuristic",
      confidence: "observed",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    owned: [{ path: "/home/.local/bin/mytool", kind: "file", exists: true, matchesInstalled: true }],
    mutated: [],
    deleted: [],
    actions: [{ path: "/home/.local/bin/mytool", action: "remove", kind: "file" }],
    requiresSudo: false,
    incomplete: false,
    delegated: { conflicts: [] },
    counts: { owned: 1, mutated: 0, deleted: 0, removable: 1, restorable: 0 },
    ...overrides,
  };
}

describe("formatInspect", () => {
  test("renders an observed record's evidence and warns that its paths are not proven", () => {
    expect(formatInspect(sampleReport())).toEqual([
      "record rec-1",
      "source install; installed 2026-10-09; executable /home/.local/bin/mytool (installed)",
      "url https://example.com/install.sh",
      "privilege user; case-sensitive paths",
      "capture macos-heuristic, heuristic attribution, no process tree (observed)",
      "\tsegment install: 2026-10-09T00:00:00.000Z → 2026-10-09T00:00:00.000Z (0.0s)",
      "tracked 1 owned, 0 mutated, 0 deleted",
      "owned paths",
      "\t/home/.local/bin/mytool (file, present, fingerprint matches)",
      "what uninstall would do",
      "\tnote: these paths are observed, not proven to belong to this tool",
      "\twould remove /home/.local/bin/mytool (observed, not proven)",
    ]);
  });

  test("a proven record carries no observed caveat or marker", () => {
    const lines = formatInspect(
      sampleReport({
        capture: {
          backend: "linux-strace",
          completeness: "complete",
          confidence: "proven",
          segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z", endedAt: "2026-10-09T00:01:00.000Z" }],
        },
      }),
    );

    expect(lines).toContain("capture linux-strace, process-tree coverage complete (proven)");
    expect(lines).toContain("\tsegment install: 2026-10-09T00:00:00.000Z → 2026-10-09T00:01:00.000Z (60.0s)");
    expect(lines).toContain("\twould remove /home/.local/bin/mytool");
    expect(lines.some((line) => line.includes("observed"))).toBe(false);
  });

  test("renders partial coverage and each segment's partial reason, including trace segments", () => {
    const lines = formatInspect(
      sampleReport({
        capture: {
          backend: "linux-strace",
          completeness: "partial",
          confidence: "observed",
          segments: [
            { kind: "install", startedAt: "2026-10-09T00:00:00.000Z", endedAt: "2026-10-09T00:00:10.000Z" },
            { kind: "trace", startedAt: "2026-10-09T01:00:00.000Z", partialReason: "a descendant daemonized" },
          ],
        },
      }),
    );

    expect(lines).toContain("capture linux-strace, process-tree coverage partial (observed)");
    expect(lines).toContain("\tsegment install: 2026-10-09T00:00:00.000Z → 2026-10-09T00:00:10.000Z (10.0s)");
    expect(lines).toContain(
      "\tsegment trace: 2026-10-09T01:00:00.000Z → 2026-10-09T01:00:00.000Z (0.0s) (a descendant daemonized)",
    );
  });

  test("omits the url line when the record has no url", () => {
    const lines = formatInspect(sampleReport({ url: "" }));
    expect(lines.some((line) => line.startsWith("url "))).toBe(false);
  });

  test("describes absent, unfingerprinted, and changed owned paths distinctly", () => {
    const lines = formatInspect(
      sampleReport({
        owned: [
          { path: "/h/gone", kind: "file", exists: false },
          { path: "/h/dir", kind: "directory", exists: true },
          { path: "/h/changed", kind: "file", exists: true, matchesInstalled: false },
        ],
        counts: { owned: 3, mutated: 0, deleted: 0, removable: 1, restorable: 0 },
        actions: [],
        delegated: { conflicts: [] },
      }),
    );

    expect(lines).toContain("\t/h/gone (file, absent)");
    expect(lines).toContain("\t/h/dir (directory, present, no fingerprint to compare)");
    expect(lines).toContain("\t/h/changed (file, present, fingerprint changed)");
  });

  test("describes mutated and deleted paths with restorability and later changes", () => {
    const lines = formatInspect(
      sampleReport({
        mutated: [
          { path: "/h/restorable", exists: true, restorable: true, changedSinceInstall: true },
          { path: "/h/detect-only", exists: true, restorable: false, changedSinceInstall: false },
        ],
        deleted: [{ path: "/h/deleted", exists: false, restorable: true, changedSinceInstall: false }],
        counts: { owned: 1, mutated: 2, deleted: 1, removable: 1, restorable: 0 },
      }),
    );

    expect(lines).toContain("\t/h/restorable (mutated, present, restorable, changed since install)");
    expect(lines).toContain("\t/h/detect-only (mutated, present, detect-only, no before-image)");
    expect(lines).toContain("\t/h/deleted (deleted, absent, restorable)");
  });

  test("lists every plan action kind, and a non-destructive plan adds no caveat", () => {
    const actions: InspectAction[] = [
      { path: "/p/skip", action: "skip", reason: "absent" },
      { path: "/p/changed", action: "detected", kind: "mutated" },
      { path: "/p/removed", action: "detected", kind: "deleted" },
      { path: "/p/conflict", action: "conflict", reason: "modified" },
    ];
    const lines = formatInspect(
      sampleReport({
        actions,
        owned: [],
        counts: { owned: 0, mutated: 0, deleted: 0, removable: 0, restorable: 0 },
      }),
    );

    expect(lines.slice(lines.indexOf("what uninstall would do") + 1)).toEqual([
      "\tskip /p/skip (absent)",
      "\tdetected /p/changed changed during install (not restored; no before-image was captured)",
      "\tdetected /p/removed was removed during install (not restored; no before-image was captured)",
      "\tconflict /p/conflict (modified)",
    ]);
  });

  test("says so plainly when there is nothing tracked to remove", () => {
    const lines = formatInspect(
      sampleReport({
        actions: [],
        owned: [],
        counts: { owned: 0, mutated: 0, deleted: 0, removable: 0, restorable: 0 },
      }),
    );
    expect(lines).toContain("\tnothing tracked to remove for mytool");
  });

  test("shows delegated removals, sudo, and conflicts alongside the plan", () => {
    const lines = formatInspect(
      sampleReport({
        name: "acmetool",
        actions: [{ path: "/home/.bun/bin/acmetool", action: "remove", kind: "symlink" }],
        requiresSudo: true,
        delegated: {
          managedBy: { manager: "bun", package: "@acme/tool" },
          managedInstall: { kind: "pi-managed-install", layout: "releases-v1", root: "/home/.pi/install" },
          conflicts: ["conflict: delegated removal of /x overlaps /x/y, claimed by other"],
        },
        counts: { owned: 1, mutated: 0, deleted: 0, removable: 1, restorable: 0 },
      }),
    );

    const fromPlan = lines.slice(lines.indexOf("what uninstall would do") + 1);
    expect(fromPlan).toEqual([
      "\tremove package @acme/tool through bun",
      "\tremove managed install releases-v1 at /home/.pi/install recursively",
      "\tnote: these paths are observed, not proven to belong to this tool",
      "\twould remove /home/.bun/bin/acmetool (observed, not proven)",
      "\tsome entries are root-owned; removing them needs sudo",
      "\tdelegated-removal conflict: conflict: delegated removal of /x overlaps /x/y, claimed by other",
    ]);
  });
});

describe("inspect CLI", () => {
  test("requires a tool name or record id", async () => {
    expect((await runCliResult(["inspect"], makeHome())).code).toBe(EXIT_USAGE);
    // A flag where the selector belongs is a usage error, not a selector named "--json".
    expect((await runCliResult(["inspect", "--json"], makeHome())).code).toBe(EXIT_USAGE);
  });

  test("an unknown tool exits with the not-found code", async () => {
    const home = makeHome();
    writeRecords(home, [record()]);
    expect((await runCliResult(["inspect", "nope"], home)).code).toBe(EXIT_NOT_FOUND);
  });

  test("a shared name is ambiguous, lists the ids, and exits with the ambiguous code", async () => {
    const home = makeHome();
    writeRecords(home, [record({ id: "rec-a", name: "dup" }), record({ id: "rec-b", name: "dup" })]);
    const result = await runCliResult(["inspect", "dup"], home);
    expect(result.code).toBe(EXIT_AMBIGUOUS);
    expect(`${result.stdout}\n${result.stderr}`).toContain("rec-a");
    expect(`${result.stdout}\n${result.stderr}`).toContain("rec-b");

    const json = await runCliResult(["inspect", "dup", "--json"], home);
    expect(json.code).toBe(EXIT_AMBIGUOUS);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: {
        code: "inspect-ambiguous",
        message: "2 tracked installs are named dup; select one by record id",
      },
    });
  });

  test("a record id selects one of several same-named records", async () => {
    const home = makeHome();
    writeRecords(home, [record({ id: "rec-a", name: "dup" }), record({ id: "rec-b", name: "dup" })]);
    const result = await runCliResult(["inspect", "rec-b", "--json"], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "inspect", tool: { id: "rec-b", name: "dup" } });
  });

  test("inspects a real install and leaves every file and the records file untouched", async () => {
    const home = makeHome();
    const binary = join(home, ".local", "bin", "mytool");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "installed");
    writeRecords(home, [
      record({
        executable: binary,
        owned: [{ path: binary, kind: "file", installedHash: sha256("installed") }],
        mutated: [{ path: join(home, ".config", "mytool.conf"), installedHash: sha256("after") }],
      }),
    ]);
    const recordsBefore = readRecordsRaw(home);
    const binaryBefore = readFileSync(binary, "utf8");

    const result = await runCliResult(["inspect", "mytool"], home);
    expect(result.code).toBe(0);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("record rec-1");
    expect(output).toContain(binary);
    expect(output).toContain("what uninstall would do");
    // Read-only: the records file is byte-identical and the tracked file was not touched.
    expect(readRecordsRaw(home)).toBe(recordsBefore);
    expect(readFileSync(binary, "utf8")).toBe(binaryBefore);
  });

  test("JSON mode prints one parseable document with the whole report and a partial state", async () => {
    const home = makeHome();
    writeRecords(home, [
      record({
        executable: join(home, "missing", "tool"),
        owned: [{ path: join(home, "missing", "tool"), kind: "file", installedHash: sha256("x") }],
      }),
    ]);
    const result = await runCliResult(["inspect", "mytool", "--json"], home);

    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      tool: { id: string; name: string; state: string; counts: { owned: number; removable: number } };
    };
    expect(document.ok).toBe(true);
    expect(document.command).toBe("inspect");
    expect(document.tool.id).toBe("rec-1");
    expect(document.tool.name).toBe("mytool");
    // The tracked executable is gone, so the record is only partially installed.
    expect(document.tool.state).toBe("partial");
    expect(document.tool.counts).toMatchObject({ owned: 1, removable: 0 });
    // stdout is the JSON document alone, with no human lines before or after it.
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    expect(result.stdout.trim().endsWith("}")).toBe(true);
  });

  test("JSON mode reports a missing tool as a structured error", async () => {
    const home = makeHome();
    writeRecords(home, [record()]);
    const result = await runCliResult(["inspect", "nope", "--json"], home);

    expect(result.code).toBe(EXIT_NOT_FOUND);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "inspect-not-found", message: "no tracked install matches nope" },
    });
  });
});
