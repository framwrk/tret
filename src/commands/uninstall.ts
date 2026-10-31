import type { AbsolutePath, ManagedInstall, ManagedPackage, RecordV3 } from "../types";
import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { FileStorage, collectUnreferencedBlobs } from "../lib/store";
import { VerifiedUninstallPlanner, formatUninstallPlan } from "../lib/uninstall-planner";
import { applyUninstallPlan, describeOutcome, reduceRecordForRetry } from "../lib/removal";
import { confirm, log } from "../lib/utilities";
import {
  describeManagedInstall,
  detectManagedInstall,
  removeManagedInstall,
  withoutManagedInstallPaths,
} from "../lib/managed-install";
import {
  describeManagedPackage,
  detectManagedPackage,
  managedPackageRemovalScope,
  removeManagedPackage,
  withoutManagedGlobalPaths,
} from "../lib/package-manager";
import { emitJson, isJsonMode } from "../lib/json-output";
import { findDelegatedRemovalConflicts, formatDelegatedRemovalConflict } from "../lib/delegated-removal";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import { planShellCleanup, removeRcLines, shellConfigPaths } from "../lib/shellconfig";
import type { ShellCleanup } from "../lib/shellconfig";
import { fail } from "../lib/failure";
import { runLogPhase } from "../lib/runlog";

/**
 * Removes a tool by planning an evidence-based uninstall, printing exactly what it will do, then
 * applying that same plan. Dry-run prints the identical plan without touching disk. A partial run
 * keeps a reduced record so a retry only sees the paths that survived. Root-owned entries are never
 * escalated for: the plan reports that sudo is required (D8).
 */
export async function uninstall(name: string | undefined, dryRun: boolean, yes: boolean, force = false): Promise<void> {
  if (!name || name.startsWith("--")) {
    fail("uninstall-usage", "uninstall requires a tool name: tret uninstall <name> [--dry-run] [--yes] [--force]", EXIT_USAGE);
  }

  const storage = new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    fail("uninstall-records", `could not read the install records: ${message(error)}`);
  }

  // Every command that acts on one record resolves its argument the same way (plan 03 item 4):
  // an exact id wins, an exact name resolves only when unique, and several name matches list the ids.
  const selection = selectRecord(records, name);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("uninstall-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("uninstall-not-found", selection.message, EXIT_NOT_FOUND);
  }
  const record = selection.record;
  // The selector may be a record id; user-facing text, JSON `tool`, and PATH-line matching all use
  // the record's display name, while the id stays alongside it in JSON.
  name = record.name;

  // A bin shim that points into a package manager's shared global state is removed through the
  // manager, not by deleting that state. The recorded `managedBy` is preferred; a record written
  // before that field existed is recognized from its executable so it is still handled safely.
  const managedPkg = record.managedBy ?? detectManagedPackage(record.executable, record.owned);
  // A first-party managed install keeps a `node_modules` payload capture never owns; the recorded
  // `managedInstall` is preferred, and a record written before the field existed is recognized from
  // its executable's marker so the root is still delegated rather than stranded `not-empty`.
  const managedInstall = record.managedInstall ?? detectManagedInstall(record.executable, record.owned);
  let target = record;
  if (managedPkg !== undefined) target = withoutManagedGlobalState(target, managedPkg);
  if (managedInstall !== undefined) target = withoutManagedInstallState(target, managedInstall);

  // Shell configs with no before-image are handled by the narrow line cleaner, not the file planner,
  // so the two never double-handle a path. Shell configs that do have a before-image are restored by
  // the planner like any other mutation; a diverged config is reported as a conflict there.
  const shellPaths = new Set(shellConfigPaths());
  const shell = planShellCleanup(target, shellPaths);
  const lineClean = new Set(shell.files);
  const fileRecord: RecordV3 = { ...target, mutated: target.mutated.filter((entry) => !lineClean.has(entry.path)) };
  const planner = new VerifiedUninstallPlanner();
  runLogPhase("plan");
  const plan = await planner.plan(fileRecord, {
    otherRecords: records,
    force,
    ...(managedInstall === undefined ? {} : { delegatedRoots: [managedInstall.root] }),
  });

  // Delegated removals can reach whole trees; planner `--force` never bypasses their overlap guard.
  const delegatedScopes: AbsolutePath[] = [];
  if (target.managedBy !== undefined) {
    const scope = managedPackageRemovalScope(target.managedBy, Bun.env.HOME);
    if (scope !== undefined) delegatedScopes.push(scope);
  }
  if (managedInstall !== undefined) delegatedScopes.push(managedInstall.root);
  const delegatedConflicts = findDelegatedRemovalConflicts(delegatedScopes, records, record, Bun.env.HOME);

  if (dryRun) {
    if (delegatedConflicts.length > 0) {
      const conflictLines = delegatedConflicts.map((conflict) => formatDelegatedRemovalConflict(conflict));
      fail(
        "uninstall-delegated-conflict",
        [...conflictLines, `${name} is blocked by delegated-removal conflicts; resolve the overlapping claim and retry`].join(
          "\n\t",
        ),
        EXIT_BLOCKED,
      );
    }
    if (isJsonMode()) {
      emitJson({
        ok: true,
        command: "uninstall",
        dryRun: true,
        tool: name,
        id: record.id,
        actions: plan.actions,
        requiresSudo: plan.requiresSudo,
        managedPackage: target.managedBy ?? null,
        managedInstall: managedInstall ?? null,
        shell: { dirs: shell.dirs, files: shell.files },
      });
      return;
    }
    printDryRun(name, plan, shell, target.managedBy, managedInstall);
    return;
  }

  if (delegatedConflicts.length > 0) {
    const conflictLines = delegatedConflicts.map((conflict) => formatDelegatedRemovalConflict(conflict));
    fail(
      "uninstall-delegated-conflict",
      [...conflictLines, `${name} is unchanged; resolve the overlapping claim and retry`].join("\n\t"),
      EXIT_BLOCKED,
    );
  }

  const hasFileWork = plan.actions.length > 0;
  const hasShellWork = shell.files.length > 0;
  const hasPackageWork = target.managedBy !== undefined;
  const hasManagedInstallWork = managedInstall !== undefined;

  if (!hasFileWork && !hasShellWork && !hasPackageWork && !hasManagedInstallWork) {
    await storage.removeRecord(record.id);
    await collectUnreferencedBlobs();
    if (isJsonMode()) {
      emitJson({ ok: true, command: "uninstall", tool: name, id: record.id, removed: [], nothingToRemove: true });
      return;
    }
    log(`removed the ${name} record; it had no tracked files`);
    return;
  }

  log(`uninstall ${name}?`);
  if (target.managedBy !== undefined) {
    log(`\tremove package ${describeManagedPackage(target.managedBy)} through ${target.managedBy.manager}`);
  }
  if (managedInstall !== undefined) {
    log(`\tremove managed install ${describeManagedInstall(managedInstall)} recursively`);
  }
  for (const line of formatUninstallPlan(plan, "apply")) {
    log(`\t${line}`);
  }
  const previewedShell = printUnresolvedShell(name, shell.dirs, shell.files, true, shell.hashes);

  if (!yes) {
    // JSON mode never prompts; a script that needs the removal to happen must pass --yes.
    const answer = isJsonMode() ? undefined : confirm("proceed? [y/N]");
    if (answer === undefined) {
      fail(
        "uninstall-consent",
        isJsonMode()
          ? "pass --yes to uninstall without a prompt in JSON mode"
          : "there is no terminal to confirm on; pass --yes to uninstall without a prompt",
        EXIT_BLOCKED,
      );
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
      fail(
        "uninstall-package",
        `could not remove package ${label}: ${removal.detail}; ${name} is unchanged; run tret uninstall again to retry`,
      );
    }
    log(`\tpackage ${label}: ${removal.detail}`);
  }

  // A managed root goes before the plan: the plan may remove the root's ancestors, which are only
  // empty once the delegated recursive removal has cleared the payload Tret does not own. The root's
  // marker is re-verified first, and a failed removal leaves every tracked path untouched.
  if (managedInstall !== undefined) {
    const removal = await removeManagedInstall(managedInstall);
    const label = describeManagedInstall(managedInstall);
    if (!removal.ok) {
      fail(
        "uninstall-managed-install",
        `could not remove managed install ${label}: ${removal.detail}; ${name} is unchanged; run tret uninstall again to retry`,
      );
    }
    log(`\tmanaged install ${label}: ${removal.detail}`);
  }

  runLogPhase("apply");
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

  const rc = removeRcLines(name, shell.dirs, false, shell.files, undefined, shell.hashes);
  for (const cleaned of rc.cleaned) {
    log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
  }
  const cleanedShell = new Set(rc.cleaned.map((cleaned) => cleaned.file));
  const failedShell = new Set(rc.failed);
  const unresolved = shell.files.filter(
    (file) => !cleanedShell.has(file) && !failedShell.has(file) && !previewedShell.has(file),
  );
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
    if (isJsonMode()) {
      emitJson({
        ok: false,
        command: "uninstall",
        tool: name,
        id: record.id,
        error: {
          code: "uninstall-incomplete",
          message: "some paths were not removed and stay tracked; run tret uninstall again to retry",
        },
        requiresSudo: plan.requiresSudo,
        outcomes: result.outcomes,
        failedShell: rc.failed,
      });
      process.exit(EXIT_ERROR);
    }
    if (plan.requiresSudo) {
      log("\tsome entries are root-owned; re-run with sudo to remove them");
    }
    fail("uninstall-incomplete", "some paths were not removed and stay tracked; run tret uninstall again to retry");
  }

  await storage.removeRecord(record.id);
  // Best-effort, outside the records lock: the record is gone, so its before-images are now
  // unreferenced. A failed sweep never turns this successful uninstall into a failure.
  await collectUnreferencedBlobs();
  if (isJsonMode()) {
    const removed = result.outcomes.filter((outcome) => outcome.outcome === "removed").map((outcome) => outcome.path);
    const restored = result.outcomes.filter((outcome) => outcome.outcome === "restored").map((outcome) => outcome.path);
    emitJson({
      ok: true,
      command: "uninstall",
      tool: name,
      id: record.id,
      removed,
      restored,
      cleanedShell: rc.cleaned.map((cleaned) => cleaned.file),
      outcomes: result.outcomes,
    });
    return;
  }
  log(`removed ${name}`);
}

/** Prints the same actions the real run will apply, with no side effects. */
function printDryRun(
  name: string,
  plan: Awaited<ReturnType<VerifiedUninstallPlanner["plan"]>>,
  shell: ShellCleanup,
  managed?: ManagedPackage,
  managedInstall?: ManagedInstall,
): void {
  const lines = formatUninstallPlan(plan, "dry-run");
  if (lines.length === 0 && shell.files.length === 0 && managed === undefined && managedInstall === undefined) {
    log(`nothing tracked to remove for ${name}`);
    return;
  }

  if (managed !== undefined) {
    log(`\twould remove package ${describeManagedPackage(managed)} through ${managed.manager}`);
  }
  if (managedInstall !== undefined) {
    log(`\twould remove managed install ${describeManagedInstall(managedInstall)} recursively`);
  }
  for (const line of lines) {
    log(`\t${line}`);
  }
  printUnresolvedShell(name, shell.dirs, shell.files, true, shell.hashes);

  if (plan.requiresSudo) {
    log("\tnote: some entries are root-owned; re-run with sudo to remove them");
  }
}

/**
 * Prints the shell-config lines the cleaner would strip, and reports any attributed config where no
 * line can be safely matched. A config without a before-image is detect-only: it is reported but
 * never keeps the record alive (D2). Returns the files already reported, so the apply pass does not
 * repeat a detect-only line the preview already printed.
 */
function printUnresolvedShell(
  name: string,
  dirs: AbsolutePath[],
  files: AbsolutePath[],
  dryRun: boolean,
  hashes: ReadonlyMap<AbsolutePath, string>,
): Set<AbsolutePath> {
  const rc = removeRcLines(name, dirs, dryRun, files, undefined, hashes);
  for (const cleaned of rc.cleaned) {
    log(`\t${dryRun ? "would clean" : "clean"} ${cleaned.file}: ${cleaned.line.trim()}`);
  }
  const cleanedFiles = new Set(rc.cleaned.map((cleaned) => cleaned.file));
  const failedFiles = new Set(rc.failed);
  const reported = new Set<AbsolutePath>();
  for (const file of files) {
    if (cleanedFiles.has(file) || failedFiles.has(file)) continue;
    log(`\tdetected ${file} changed during install (not restored; no before-image was captured)`);
    reported.add(file);
  }
  return reported;
}

/**
 * Drops a managed package's shared global state from a record so uninstall never plans to delete it.
 * The bin shim (outside the global root) stays owned and is still removed; the manifest, lockfile,
 * and shared node_modules are left to the package manager. A record that predates `managedBy` gets
 * the detected value stamped on so a retry keeps deferring to the manager.
 */
function withoutManagedGlobalState(record: RecordV3, managed: ManagedPackage): RecordV3 {
  const home = Bun.env.HOME;
  return {
    ...record,
    managedBy: record.managedBy ?? managed,
    owned: withoutManagedGlobalPaths(record.owned, managed, home),
    mutated: withoutManagedGlobalPaths(record.mutated, managed, home),
    deleted: withoutManagedGlobalPaths(record.deleted, managed, home),
  };
}

/**
 * Drops a managed install's root subtree from a record so uninstall never plans to delete the
 * payload capture does not own. The launcher and PATH entrypoint outside the root stay owned and
 * are still removed; the root is cleared by the delegated recursive removal. A record that predates
 * `managedInstall` gets the detected value stamped on so a retry keeps delegating.
 */
function withoutManagedInstallState(record: RecordV3, managed: ManagedInstall): RecordV3 {
  return {
    ...record,
    managedInstall: record.managedInstall ?? managed,
    owned: withoutManagedInstallPaths(record.owned, managed),
    mutated: withoutManagedInstallPaths(record.mutated, managed),
    deleted: withoutManagedInstallPaths(record.deleted, managed),
  };
}

/**
 * Saves the reduced record, or drops it when nothing is left to retry.
 */
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
