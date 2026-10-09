import type { AbsolutePath, ManagedPackage, RecordV3 } from "../types";
import { VerifiedUninstallPlanner, formatUninstallPlan, inspectPath } from "../lib/uninstall-planner";
import { applyUninstallPlan, describeOutcome, reduceRecordForRetry } from "../lib/removal";
import { confirm, log } from "../lib/utilities";
import {
  describeManagedPackage,
  detectManagedPackage,
  isManagedGlobalPath,
  removeManagedPackage,
} from "../lib/package-manager";
import { removeRcLines, shellConfigPaths } from "../lib/shellconfig";
import { FileStorage } from "../lib/store";

/** The shell-config work an uninstall may do, kept separate from the file plan. */
type ShellCleanup = {
  /** Owned paths whose mention in a config line the install is allowed to strip. */
  dirs: AbsolutePath[];
  /** Attributed config files with no before-image, still matching their installed state, safe to line-clean. */
  files: AbsolutePath[];
};

/**
 * Removes a tool by planning an evidence-based uninstall, printing exactly what it will do, then
 * applying that same plan. Dry-run prints the identical plan without touching disk. A partial run
 * keeps a reduced record so a retry only sees the paths that survived. Root-owned entries are never
 * escalated for: the plan reports that sudo is required (D8).
 */
export async function uninstall(name: string | undefined, dryRun: boolean, yes: boolean, force = false): Promise<void> {
  if (!name || name.startsWith("--")) {
    log("Error");
    log("\tuninstall requires a tool name: tret uninstall <name> [--dry-run] [--yes] [--force]");
    process.exit(1);
  }

  const storage = new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    log("Error");
    log(`\tcould not read the install records: ${message(error)}`);
    process.exit(1);
  }

  const record = records.find((existing) => existing.name === name);
  if (!record) {
    log("Error");
    log(`\tno tracked install named ${name}; see tret list`);
    process.exit(1);
  }

  // A bin shim that points into a package manager's shared global state is removed through the
  // manager, not by deleting that state. The recorded `managedBy` is preferred; a record written
  // before that field existed is recognized from its executable so it is still handled safely.
  const managed = record.managedBy ?? detectManagedPackage(record.executable, record.owned);
  const target = managed === undefined ? record : withoutManagedGlobalState(record, managed);

  // Shell configs with no before-image are handled by the narrow line cleaner, not the file planner,
  // so the two never double-handle a path. Shell configs that do have a before-image are restored by
  // the planner like any other mutation; a diverged config is reported as a conflict there.
  const shellPaths = new Set(shellConfigPaths());
  const shell = planShellCleanup(target, shellPaths);
  const lineClean = new Set(shell.files);
  const fileRecord: RecordV3 = { ...target, mutated: target.mutated.filter((entry) => !lineClean.has(entry.path)) };
  const planner = new VerifiedUninstallPlanner();
  const plan = await planner.plan(fileRecord, { otherRecords: records, force });

  if (dryRun) {
    printDryRun(name, plan, shell, target.managedBy);
    return;
  }

  const hasFileWork = plan.actions.length > 0;
  const hasShellWork = shell.files.length > 0;
  const hasPackageWork = target.managedBy !== undefined;

  if (!hasFileWork && !hasShellWork && !hasPackageWork) {
    await storage.removeRecord(record.id);
    log(`removed the ${name} record; it had no tracked files`);
    return;
  }

  log(`uninstall ${name}?`);
  if (target.managedBy !== undefined) {
    log(`\tremove package ${describeManagedPackage(target.managedBy)} through ${target.managedBy.manager}`);
  }
  for (const line of formatUninstallPlan(plan, "apply")) {
    log(`\t${line}`);
  }
  printUnresolvedShell(name, shell.dirs, shell.files, true);

  if (!yes) {
    const answer = confirm("proceed? [y/N]");
    if (answer === undefined) {
      log("Error");
      log("\tthere is no terminal to confirm on; pass --yes to uninstall without a prompt");
      process.exit(1);
    }
    if (!answer) {
      log(`aborted; ${name} is unchanged`);
      process.exit(0);
    }
  }

  // The package manager goes first. A global package owns its own shim and its shared state, so only
  // once the manager reports the package gone does Tret remove the rest; a failed removal leaves
  // every tracked path untouched and keeps the record for a retry.
  if (target.managedBy !== undefined) {
    const removal = await removeManagedPackage(target.managedBy, { home: Bun.env.HOME });
    const label = describeManagedPackage(target.managedBy);
    if (!removal.ok) {
      log(`\tcould not remove package ${label}: ${removal.detail}`);
      log("Error");
      log(`\t${name} is unchanged; run tret uninstall again to retry`);
      process.exit(1);
    }
    log(`\tpackage ${label}: ${removal.detail}`);
  }

  const result = await applyUninstallPlan(plan, { storage });
  // Conflicts, already-absent paths, and detect-only changes were described in the plan above; only
  // report the outcomes the plan did not announce (removals, restores, and anything that failed at apply).
  const announced = new Set(
    plan.actions
      .filter((action) => action.action === "conflict" || action.action === "skip" || action.action === "detected")
      .map((action) => action.path),
  );
  for (const outcome of result.outcomes) {
    if (
      (outcome.outcome === "conflict" || outcome.outcome === "skipped" || outcome.outcome === "detected") &&
      announced.has(outcome.path)
    )
      continue;
    log(`\t${describeOutcome(outcome)}`, true);
  }

  const rc = removeRcLines(name, shell.dirs, false, shell.files);
  for (const cleaned of rc.cleaned) {
    log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
  }
  const cleanedShell = new Set(rc.cleaned.map((cleaned) => cleaned.file));
  const unresolved = shell.files.filter((file) => !cleanedShell.has(file));
  for (const file of unresolved) {
    // A shell config with no before-image is detect-only: report it, but never let it block (D2).
    log(`\tdetected ${file} changed during install (not restored; no before-image was captured)`);
  }
  for (const file of rc.failed) {
    log(`\tcould not clean ${file}`);
  }

  // Only actionable work blocks: file conflicts/failures and a shell config Tret could not read or
  // write. A failed package removal exited above, so nothing is left pending here. Detect-only
  // leftovers (no before-image) never keep a record alive.
  const incomplete = result.incomplete || rc.failed.length > 0;
  if (incomplete) {
    const reduced = reduceRecordForRetry(target, result, cleanedShell);
    await persistRetry(storage, reduced);
    if (plan.requiresSudo) {
      log("\tsome entries are root-owned; re-run with sudo to remove them");
    }
    log("Error");
    log("\tsome paths were not removed and stay tracked; run tret uninstall again to retry");
    process.exit(1);
  }

  await storage.removeRecord(record.id);
  log(`removed ${name}`);
}

/** Prints the same actions the real run will apply, with no side effects. */
function printDryRun(
  name: string,
  plan: Awaited<ReturnType<VerifiedUninstallPlanner["plan"]>>,
  shell: ShellCleanup,
  managed?: ManagedPackage,
): void {
  const lines = formatUninstallPlan(plan, "dry-run");
  if (lines.length === 0 && shell.files.length === 0 && managed === undefined) {
    log(`nothing tracked to remove for ${name}`);
    return;
  }

  if (managed !== undefined) {
    log(`\twould remove package ${describeManagedPackage(managed)} through ${managed.manager}`);
  }
  for (const line of lines) {
    log(`\t${line}`);
  }
  printUnresolvedShell(name, shell.dirs, shell.files, true);

  if (plan.requiresSudo) {
    log("\tnote: some entries are root-owned; re-run with sudo to remove them");
  }
}

/**
 * Prints the shell-config lines the cleaner would strip, and reports any attributed config where no
 * line can be safely matched. A config without a before-image is detect-only: it is reported but
 * never keeps the record alive (D2).
 */
function printUnresolvedShell(name: string, dirs: AbsolutePath[], files: AbsolutePath[], dryRun: boolean): void {
  const rc = removeRcLines(name, dirs, dryRun, files);
  for (const cleaned of rc.cleaned) {
    log(`\t${dryRun ? "would clean" : "clean"} ${cleaned.file}: ${cleaned.line.trim()}`);
  }
  const cleanedFiles = new Set(rc.cleaned.map((cleaned) => cleaned.file));
  for (const file of files) {
    if (!cleanedFiles.has(file)) {
      log(`\tdetected ${file} changed during install (not restored; no before-image was captured)`);
    }
  }
}

/**
 * Drops a managed package's shared global state from a record so uninstall never plans to delete it.
 * The bin shim (outside the global root) stays owned and is still removed; the manifest, lockfile,
 * and shared node_modules are left to the package manager. A record that predates `managedBy` gets
 * the detected value stamped on so a retry keeps deferring to the manager.
 */
function withoutManagedGlobalState(record: RecordV3, managed: ManagedPackage): RecordV3 {
  const home = Bun.env.HOME;
  if (!home) return { ...record, managedBy: record.managedBy ?? managed };

  const keep = (entry: { path: AbsolutePath }): boolean => !isManagedGlobalPath(entry.path, managed, home);
  return {
    ...record,
    managedBy: record.managedBy ?? managed,
    owned: record.owned.filter(keep),
    mutated: record.mutated.filter(keep),
    deleted: record.deleted.filter(keep),
  };
}

/**
 * Selects the attributed shell-config mutations the narrow line cleaner should handle: those with
 * no before-image (a before-image is restored by the planner like any other mutation) and whose
 * bytes still match the recorded installed state. A config edited after install is left to the
 * planner, which reports it as a conflict rather than risking a user's later edit.
 */
function planShellCleanup(record: RecordV3, shellPaths: Set<AbsolutePath>): ShellCleanup {
  const dirs = record.owned.map((entry) => entry.path);
  const files: AbsolutePath[] = [];

  for (const entry of record.mutated) {
    if (!shellPaths.has(entry.path)) continue;
    if (entry.beforeBlob !== undefined) continue;
    if (entry.installedHash !== undefined) {
      const verification = inspectPath(entry.path);
      if (verification.exists && verification.hash !== undefined && verification.hash !== entry.installedHash) {
        continue;
      }
    }
    files.push(entry.path);
  }

  return { dirs, files };
}

/** Saves the reduced record, or drops it when nothing is left to retry. */
async function persistRetry(storage: FileStorage, reduced: RecordV3): Promise<void> {
  const remaining = reduced.owned.length + reduced.mutated.length + reduced.deleted.length;
  if (remaining === 0) {
    await storage.removeRecord(reduced.id);
    return;
  }
  await storage.saveRecord(reduced);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
