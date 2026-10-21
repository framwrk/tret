// `tret trace <tool>` (plan 03 item 2).
//
// Runs one tracked tool inside a bounded observation window and appends what it writes to the
// record as a separate `trace` segment. Tracing is explicit and opt-in: the command asks before
// running the tool, never runs it silently, and only ever adds paths the tool demonstrably wrote.
// A path another record already claims is reported and skipped, so a trace can never take ownership
// away from another tool. The install's own observation window is unchanged; the trace segment
// records this window's coverage next to it.

import type { AbsolutePath, CaptureSegment, DeletedEntry, MutatedEntry, OwnedEntry, RecordV3 } from "../types";
import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { claimedByOthers, sharedClaim } from "../lib/uninstall-planner";
import { confirm, log } from "../lib/utilities";
import { currentPlatform, processPrivilege } from "../lib/platform";
import { emitJson, isJsonMode } from "../lib/json-output";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import { DEFAULT_BACKUP_POLICY } from "../lib/store";
import { FileStorage } from "../lib/store";
import type { NormalizedEffects } from "../lib/capture/normalize";
import { captureBackendFor } from "../lib/capture/current";
import { fail } from "../lib/failure";
import { installObservationRoots } from "../lib/platform/roots";
import { normalizeJournal } from "../lib/journal/normalize";
import { runBoundedSession } from "../lib/session";
import { runProgram } from "../lib/installer";

/** Why a path the trace saw was not merged into the record. */
export type TraceSkipReason = "already-tracked" | "claimed-by-other";

/** One path the trace observed but did not merge. */
export type TraceSkip = {
  path: AbsolutePath;
  reason: TraceSkipReason;
};

/** The paths a trace merged into a record. */
export type TraceAdded = {
  owned: OwnedEntry[];
  mutated: MutatedEntry[];
  deleted: DeletedEntry[];
};

/** The result of merging one trace's effects into a record. */
export type TraceMergeResult = {
  record: RecordV3;
  added: TraceAdded;
  skipped: TraceSkip[];
};

/**
 * Merges one trace's normalized effects into `record`, without taking ownership of a path another
 * record already claims. A path the record already tracks — as owned, mutated, or deleted — is left
 * as it is: the install's original evidence is more specific than a later trace. A path another
 * record claims is skipped and reported rather than silently added. No disk state changes here.
 */
export function mergeTraceEffects(
  record: RecordV3,
  effects: NormalizedEffects,
  records: RecordV3[],
): TraceMergeResult {
  const ownedPaths = new Set(record.owned.map((entry) => entry.path));
  const mutatedPaths = new Set(record.mutated.map((entry) => entry.path));
  const deletedPaths = new Set(record.deleted.map((entry) => entry.path));
  const claims = claimedByOthers(records, record.id);

  const added: TraceAdded = { owned: [], mutated: [], deleted: [] };
  const skipped: TraceSkip[] = [];

  for (const entry of effects.owned) {
    if (ownedPaths.has(entry.path) || mutatedPaths.has(entry.path) || deletedPaths.has(entry.path)) {
      skipped.push({ path: entry.path, reason: "already-tracked" });
      continue;
    }
    if (sharedClaim(claims, entry.path, record.caseSensitive)) {
      skipped.push({ path: entry.path, reason: "claimed-by-other" });
      continue;
    }
    ownedPaths.add(entry.path);
    added.owned.push(entry);
  }

  for (const entry of effects.mutated) {
    if (ownedPaths.has(entry.path) || mutatedPaths.has(entry.path) || deletedPaths.has(entry.path)) {
      skipped.push({ path: entry.path, reason: "already-tracked" });
      continue;
    }
    if (sharedClaim(claims, entry.path, record.caseSensitive)) {
      skipped.push({ path: entry.path, reason: "claimed-by-other" });
      continue;
    }
    mutatedPaths.add(entry.path);
    added.mutated.push(entry);
  }

  for (const entry of effects.deleted) {
    if (ownedPaths.has(entry.path) || mutatedPaths.has(entry.path) || deletedPaths.has(entry.path)) {
      skipped.push({ path: entry.path, reason: "already-tracked" });
      continue;
    }
    if (sharedClaim(claims, entry.path, record.caseSensitive)) {
      skipped.push({ path: entry.path, reason: "claimed-by-other" });
      continue;
    }
    deletedPaths.add(entry.path);
    added.deleted.push(entry);
  }

  return {
    record: {
      ...record,
      owned: [...record.owned, ...added.owned],
      mutated: [...record.mutated, ...added.mutated],
      deleted: [...record.deleted, ...added.deleted],
    },
    added,
    skipped,
  };
}

/** Seams for tests: the record storage and the bounded session are both replaceable. */
export type TraceOptions = {
  storage?: FileStorage;
  /** Runs the observed work; tests replace the real child process. */
  run?: () => Promise<number>;
  /** Absolute roots to observe; defaults to the platform's bounded install roots. */
  roots?: AbsolutePath[];
  /** Clock; injectable so tests can pin the window timestamps. */
  now?: () => number;
};

/** The command entry: resolve one record, ask, run the tool in a trace window, and merge what it wrote. */
export async function trace(
  selector: string | undefined,
  yes: boolean,
  options: TraceOptions = {},
): Promise<void> {
  if (!selector || selector.startsWith("--")) {
    fail("trace-usage", "trace requires a tool name or record id: tret trace <tool>", EXIT_USAGE);
  }

  const storage = options.storage ?? new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    fail("trace-records", `could not read the install records: ${message(error)}`);
  }

  const selection = selectRecord(records, selector);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("trace-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("trace-not-found", selection.message, EXIT_NOT_FOUND);
  }

  const record = selection.record;
  if (record.executable === "") {
    fail("trace-executable", `${record.name} has no tracked executable to run`, EXIT_USAGE);
  }

  // Ask before running the tool. Tracing runs the real program, so it is never silent: JSON mode and
  // non-interactive runs require --yes instead of pretending to have asked.
  if (!yes && !isJsonMode() && process.stdin.isTTY) {
    const answer = confirm(`run ${record.executable} in an observation window? [y/N]`);
    if (answer === undefined) {
      fail("trace-consent", "could not read a confirmation; pass --yes to run the tool", EXIT_BLOCKED);
    }
    if (!answer) {
      log("aborted; nothing was traced");
      return;
    }
  }

  const platform = currentPlatform();
  const roots = options.roots ?? installObservationRoots(platform);
  const run = options.run ?? (() => runProgram(record.executable));

  // Capture starts before the tool runs and the tool is a descendant of this process, so the whole
  // invocation is inside the observed tree. A backend that cannot attach throws before `run`, so the
  // tool is never run unwatched: the command fails instead.
  let window;
  try {
    window = await runBoundedSession({
      backend: captureBackendFor(platform, record.caseSensitive),
      pid: process.pid,
      privilege: processPrivilege(),
      roots,
      kind: "trace",
      run,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    fail("trace-capture", `could not attach a capture window; the tool was not run: ${message(error)}`);
  }

  const effects = normalizeJournal({
    journal: window.journal,
    backups: DEFAULT_BACKUP_POLICY,
    caseSensitive: record.caseSensitive,
    availableBeforeImages: new Set(window.journal.beforeImages?.keys() ?? []),
  });

  const merged = mergeTraceEffects(record, effects, records);
  const segment: CaptureSegment = window.coverage.segment;
  const updated: RecordV3 = {
    ...merged.record,
    capture: { ...record.capture, segments: [...(record.capture.segments ?? []), segment] },
  };
  await storage.saveRecord(updated);

  const exitCode = window.value ?? 1;
  if (isJsonMode()) {
    emitJson({
      ok: true,
      command: "trace",
      tool: record.name,
      id: record.id,
      backend: window.coverage.backend,
      completeness: window.coverage.completeness,
      events: window.coverage.events,
      exitCode,
      segment,
      added: {
        owned: merged.added.owned.length,
        mutated: merged.added.mutated.length,
        deleted: merged.added.deleted.length,
      },
      skipped: merged.skipped,
      diagnostics: effects.diagnostics,
    });
    return;
  }

  log(`trace ${record.name}`);
  log(`\tobserved ${window.coverage.backend}: ${describeCoverage(window.coverage)}`);
  log(`\ttrace window ${segment.startedAt} → ${segment.endedAt ?? segment.startedAt}`);
  if (exitCode !== 0) log(`\tthe tool exited with code ${exitCode}; the trace is still recorded`);

  const addedTotal = merged.added.owned.length + merged.added.mutated.length + merged.added.deleted.length;
  if (addedTotal === 0 && merged.skipped.length === 0 && effects.diagnostics.length === 0) {
    log("\tno new paths; the record is unchanged");
    return;
  }

  if (merged.added.owned.length > 0) {
    log("\tnew owned paths");
    for (const entry of merged.added.owned) log(`\t\t${entry.path} (${entry.kind})`);
  }
  if (merged.added.mutated.length > 0) {
    log("\tnew changes");
    for (const entry of merged.added.mutated) log(`\t\t${entry.path} changed`);
  }
  if (merged.added.deleted.length > 0) {
    log("\tnew deletions");
    for (const entry of merged.added.deleted) log(`\t\t${entry.path} removed`);
  }
  if (merged.skipped.length > 0) {
    log("\tskipped");
    for (const skip of merged.skipped) {
      log(
        skip.reason === "claimed-by-other"
          ? `\t\t${skip.path} is claimed by another tracked record; left untouched`
          : `\t\t${skip.path} is already tracked by this record`,
      );
    }
  }
  for (const diagnostic of effects.diagnostics) {
    const paths = diagnostic.paths.length === 0 ? "" : ` (${diagnostic.paths.join(", ")})`;
    log(`\tdiagnostic ${diagnostic.code}: ${diagnostic.message}${paths}`);
  }
  log(`\tmerged ${addedTotal} new path${addedTotal === 1 ? "" : "s"} into ${record.name}`);
}

/** One-line coverage summary without the roots list `formatCoverage` includes. */
function describeCoverage(coverage: { completeness: string; partialReason?: string }): string {
  switch (coverage.completeness) {
    case "complete":
      return "process-tree coverage complete";
    case "partial":
      return `process-tree coverage partial${coverage.partialReason === undefined ? "" : `: ${coverage.partialReason}`}`;
    case "heuristic":
      return `heuristic attribution, no process tree${coverage.partialReason === undefined ? "" : `: ${coverage.partialReason}`}`;
    default:
      return coverage.completeness;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
