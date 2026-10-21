// `tret inspect <tool>` (plan 03 item 1).
//
// A read-only health check for one tracked record: what the capture proved, when its observation
// window was open, which paths Tret believes it owns, which of those are still on disk and still
// match the recorded fingerprint, which changes have a before-image and can be restored, and what an
// uninstall would do. Nothing here writes to disk, the records file, or the tool's files: the same
// planner `uninstall` uses runs in preview mode, so the preview cannot diverge from the real plan.

import type { CaptureCompleteness, CaptureSegment, OwnedKind, OwnershipConfidence, Privilege, RecordV3 } from "../types";
import { EXIT_AMBIGUOUS, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import type { UninstallPlanner, UninstallVerification } from "../lib/uninstall-planner";
import { VerifiedUninstallPlanner, inspectPath } from "../lib/uninstall-planner";
import { delegatedScopes, recordTarget } from "../lib/record-target";
import { emitJson, isJsonMode } from "../lib/json-output";
import { findDelegatedRemovalConflicts, formatDelegatedRemovalConflict } from "../lib/delegated-removal";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import { FileStorage } from "../lib/store";
import { fail } from "../lib/failure";
import { formatWindow } from "../lib/session";
import { log } from "../lib/utilities";
import { ownershipConfidence } from "../lib/ownership";

/** One owned path and what the on-disk state says about it. */
export type InspectOwned = {
  path: string;
  kind: OwnedKind;
  exists: boolean;
  /** Whether the current bytes still match the installed fingerprint; absent when there is none to compare. */
  matchesInstalled?: boolean;
};

/** One pre-existing path the install changed or removed. */
export type InspectChanged = {
  path: string;
  exists: boolean;
  /** A before-image blob is recorded, so the change can be restored. */
  restorable: boolean;
  /** The current state no longer matches the installed state. */
  changedSinceInstall: boolean;
};

/** One uninstall-plan step in a shape that survives JSON and reads plainly in a terminal. */
export type InspectAction = {
  path: string;
  action: "remove" | "restore" | "skip" | "detected" | "conflict";
  reason?: string;
  kind?: string;
};

/** The complete, structured result of inspecting one record; the JSON document is this object. */
export type InspectReport = {
  id: string;
  name: string;
  source: string;
  url: string;
  installedAt: string;
  executable: string;
  state: "installed" | "partial";
  privilege: Privilege;
  caseSensitive: boolean;
  capture: {
    backend: string;
    completeness: CaptureCompleteness;
    confidence: OwnershipConfidence;
    segments: CaptureSegment[];
  };
  owned: InspectOwned[];
  mutated: InspectChanged[];
  deleted: InspectChanged[];
  actions: InspectAction[];
  requiresSudo: boolean;
  incomplete: boolean;
  delegated: {
    managedBy?: { manager: string; package: string };
    managedInstall?: { kind: string; layout: string; root: string };
    conflicts: string[];
  };
  counts: {
    owned: number;
    mutated: number;
    deleted: number;
    removable: number;
    restorable: number;
  };
};

/** Seams for tests: the path inspector and the planner can both be replaced. */
export type InspectOptions = {
  inspect?: (path: string) => UninstallVerification;
  planner?: UninstallPlanner;
  home?: string | undefined;
  /** Whether the executable is still on disk; defaults to a real filesystem check. */
  executableExists?: (path: string) => boolean;
};

/** Builds the read-only report for one record; no disk state is changed. */
export async function buildInspectReport(
  record: RecordV3,
  records: RecordV3[],
  options: InspectOptions = {},
): Promise<InspectReport> {
  const inspect = options.inspect ?? ((path: string) => inspectPath(path));
  const home = options.home ?? Bun.env.HOME;
  const target = recordTarget(record, home);
  const planner = options.planner ?? new VerifiedUninstallPlanner(inspect);
  const plan = await planner.plan(target.record, {
    otherRecords: records,
    ...(target.managedInstall === undefined ? {} : { delegatedRoots: [target.managedInstall.root] }),
  });

  const conflicts = findDelegatedRemovalConflicts(delegatedScopes(target, home), records, record, home).map(
    (conflict) => formatDelegatedRemovalConflict(conflict),
  );

  const owned: InspectOwned[] = target.record.owned.map((entry) => {
    const verification = inspect(entry.path);
    const matchesInstalled =
      verification.exists && entry.installedHash !== undefined ? verification.hash === entry.installedHash : undefined;
    return {
      path: entry.path,
      kind: entry.kind,
      exists: verification.exists,
      ...(matchesInstalled === undefined ? {} : { matchesInstalled }),
    };
  });

  const mutated: InspectChanged[] = target.record.mutated.map((entry) => {
    const verification = inspect(entry.path);
    return {
      path: entry.path,
      exists: verification.exists,
      restorable: entry.beforeBlob !== undefined,
      changedSinceInstall:
        !verification.exists ||
        (entry.installedHash !== undefined && verification.hash !== entry.installedHash),
    };
  });

  const deleted: InspectChanged[] = target.record.deleted.map((entry) => {
    const verification = inspect(entry.path);
    return {
      path: entry.path,
      exists: verification.exists,
      restorable: entry.beforeBlob !== undefined,
      // A path recorded as deleted that exists again was recreated after the install.
      changedSinceInstall: verification.exists,
    };
  });

  const actions: InspectAction[] = plan.actions.map((action) => {
    switch (action.action) {
      case "remove":
        return { path: action.path, action: "remove", kind: action.kind };
      case "restore":
        return { path: action.path, action: "restore", kind: action.kind };
      case "skip":
        return { path: action.path, action: "skip", reason: action.reason };
      case "detected":
        return { path: action.path, action: "detected", kind: action.kind };
      case "conflict":
        return { path: action.path, action: "conflict", reason: action.reason };
    }
  });

  return {
    id: record.id,
    name: record.name,
    source: record.source,
    url: record.url,
    installedAt: record.installedAt,
    executable: record.executable,
    state: executableIsPresent(record, options) ? "installed" : "partial",
    privilege: record.privilege,
    caseSensitive: record.caseSensitive,
    capture: {
      backend: record.capture.backend,
      completeness: record.capture.completeness,
      confidence: ownershipConfidence(record.capture.completeness),
      segments: record.capture.segments,
    },
    owned,
    mutated,
    deleted,
    actions,
    requiresSudo: plan.requiresSudo,
    incomplete: plan.incomplete,
    delegated: {
      ...(target.managedBy === undefined
        ? {}
        : { managedBy: { manager: target.managedBy.manager, package: target.managedBy.package } }),
      ...(target.managedInstall === undefined
        ? {}
        : {
            managedInstall: {
              kind: target.managedInstall.kind,
              layout: target.managedInstall.layout,
              root: target.managedInstall.root,
            },
          }),
      conflicts,
    },
    counts: {
      owned: owned.length,
      mutated: mutated.length,
      deleted: deleted.length,
      removable: actions.filter((action) => action.action === "remove").length,
      restorable: actions.filter((action) => action.action === "restore").length,
    },
  };
}

/** Renders the report as the human lines `tret inspect` prints. */
export function formatInspect(report: InspectReport): string[] {
  const lines: string[] = [];
  lines.push(`record ${report.id}`);
  lines.push(
    `source ${report.source}; installed ${report.installedAt.slice(0, 10)}; executable ${report.executable || "-"} (${report.state})`,
  );
  if (report.url) lines.push(`url ${report.url}`);
  lines.push(`privilege ${report.privilege}; ${report.caseSensitive ? "case-sensitive" : "case-insensitive"} paths`);
  lines.push(
    `capture ${report.capture.backend}, ${describeCompleteness(report.capture.completeness)} (${report.capture.confidence})`,
  );
  for (const segment of report.capture.segments) {
    const reason = segment.partialReason === undefined ? "" : ` (${segment.partialReason})`;
    lines.push(`\tsegment ${segment.kind}: ${formatWindow(segment)}${reason}`);
  }

  lines.push(`tracked ${report.counts.owned} owned, ${report.counts.mutated} mutated, ${report.counts.deleted} deleted`);
  if (report.owned.length > 0) {
    lines.push("owned paths");
    for (const entry of report.owned) lines.push(`\t${describeOwned(entry)}`);
  }
  if (report.mutated.length > 0 || report.deleted.length > 0) {
    lines.push("changed since install");
    for (const entry of report.mutated) lines.push(`\t${describeChanged(entry, "mutated")}`);
    for (const entry of report.deleted) lines.push(`\t${describeChanged(entry, "deleted")}`);
  }

  lines.push("what uninstall would do");
  if (report.actions.length === 0 && report.delegated.managedBy === undefined && report.delegated.managedInstall === undefined) {
    lines.push(`\tnothing tracked to remove for ${report.name}`);
  } else {
    if (report.delegated.managedBy !== undefined) {
      lines.push(`\tremove package ${report.delegated.managedBy.package} through ${report.delegated.managedBy.manager}`);
    }
    if (report.delegated.managedInstall !== undefined) {
      lines.push(`\tremove managed install ${report.delegated.managedInstall.layout} at ${report.delegated.managedInstall.root} recursively`);
    }
    for (const line of formatPlanLines(report)) lines.push(`\t${line}`);
  }
  if (report.requiresSudo) lines.push("\tsome entries are root-owned; removing them needs sudo");
  for (const conflict of report.delegated.conflicts) lines.push(`\tdelegated-removal conflict: ${conflict}`);

  return lines;
}

/** The command entry: resolve one record read-only, print its report, and exit without side effects. */
export async function inspect(selector: string | undefined): Promise<void> {
  if (!selector || selector.startsWith("--")) {
    fail("inspect-usage", "inspect requires a tool name or record id: tret inspect <tool>", EXIT_USAGE);
  }

  let records: RecordV3[];
  try {
    records = await new FileStorage().loadRecords();
  } catch (error) {
    fail("inspect-records", `could not read the install records: ${message(error)}`);
  }

  const selection = selectRecord(records, selector);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("inspect-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("inspect-not-found", selection.message, EXIT_NOT_FOUND);
  }

  const report = await buildInspectReport(selection.record, records);
  if (isJsonMode()) {
    emitJson({ ok: true, command: "inspect", tool: report });
    return;
  }

  log(`inspect ${report.name}`);
  for (const line of formatInspect(report)) log(`\t${line}`);
}

/** The human plan lines for the report, reusing the uninstall formatter so both read identically. */
function formatPlanLines(report: InspectReport): string[] {
  const marker = report.capture.confidence === "observed" ? " (observed, not proven)" : "";
  const lines = report.actions.map((action) => {
    switch (action.action) {
      case "remove":
        return `would remove ${action.path}${marker}`;
      case "restore":
        return `would restore ${action.path}${marker}`;
      case "skip":
        return `skip ${action.path} (${action.reason})`;
      case "detected":
        return action.kind === "deleted"
          ? `detected ${action.path} was removed during install (not restored; no before-image was captured)`
          : `detected ${action.path} changed during install (not restored; no before-image was captured)`;
      case "conflict":
        return `conflict ${action.path} (${action.reason})`;
    }
  });
  if (lines.some((line) => line.startsWith("would remove") || line.startsWith("would restore")) && marker !== "") {
    return ["note: these paths are observed, not proven to belong to this tool", ...lines];
  }
  return lines;
}

function describeOwned(entry: InspectOwned): string {
  if (!entry.exists) return `${entry.path} (${entry.kind}, absent)`;
  if (entry.matchesInstalled === undefined) return `${entry.path} (${entry.kind}, present, no fingerprint to compare)`;
  return `${entry.path} (${entry.kind}, present, fingerprint ${entry.matchesInstalled ? "matches" : "changed"})`;
}

function describeChanged(entry: InspectChanged, kind: "mutated" | "deleted"): string {
  const state = entry.exists ? "present" : "absent";
  const restore = entry.restorable ? "restorable" : "detect-only, no before-image";
  return `${entry.path} (${kind}, ${state}, ${restore}${entry.changedSinceInstall ? ", changed since install" : ""})`;
}

function describeCompleteness(completeness: CaptureCompleteness): string {
  switch (completeness) {
    case "complete":
      return "process-tree coverage complete";
    case "partial":
      return "process-tree coverage partial";
    case "heuristic":
      return "heuristic attribution, no process tree";
  }
}

function executableIsPresent(record: RecordV3, options: InspectOptions): boolean {
  if (record.executable === "") return false;
  if (options.executableExists !== undefined) return options.executableExists(record.executable);
  return inspectPath(record.executable).exists;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
