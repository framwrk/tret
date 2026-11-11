import type { AbsolutePath, RecordV3 } from "../types";
import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { FileStorage, collectUnreferencedBlobs } from "../lib/store";
import { VerifiedUninstallPlanner, formatUninstallPlan } from "../lib/uninstall-planner";
import { applyUninstallPlan, describeOutcome, reduceRecordForRetry } from "../lib/removal";
import { confirm, log } from "../lib/utilities";
import { delegatedRemovalBlocks, delegatedScopes, recordTarget } from "../lib/record-target";
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

  const delegated = recordTarget(record);
  const target = delegated.record;
  const conflicts = findDelegatedRemovalConflicts(delegatedScopes(delegated), records, record, Bun.env.HOME);
  if (conflicts.length > 0) {
    fail("uninstall-delegated-conflict", conflicts.map(formatDelegatedRemovalConflict).join("\n\t"), EXIT_BLOCKED);
  }
  const blocked = delegatedRemovalBlocks(delegated);
  if (blocked.length > 0) {
    fail("uninstall-delegated-unverified", `${blocked.join("; ")}; ${name} is unchanged`, EXIT_BLOCKED);
  }

  // Shell configs with no before-image are handled by the narrow line cleaner, not the file planner,
  // so the two never double-handle a path. Shell configs that do have a before-image are restored by
  // the planner like any other mutation; a diverged config is reported as a conflict there.
  const shellPaths = new Set(shellConfigPaths());
  const shell = planShellCleanup(target, shellPaths, { otherRecords: records });
  const lineClean = new Set(shell.files);
  const fileRecord: RecordV3 = { ...target, mutated: target.mutated.filter((entry) => !lineClean.has(entry.path)) };
  const planner = new VerifiedUninstallPlanner();
  runLogPhase("plan");
  const plan = await planner.plan(fileRecord, {
    otherRecords: records,
    force,
  });

  if (dryRun) {
    if (isJsonMode()) {
      emitJson({
        ok: true,
        command: "uninstall",
        dryRun: true,
        tool: name,
        id: record.id,
        actions: plan.actions.map((action) => {
          if (action.action !== "remove" && action.action !== "restore") return action;
          const plannedState = { ...action.plannedState };
          delete plannedState.identity;
          return { ...action, plannedState };
        }),
        requiresSudo: plan.requiresSudo,
        managedPackage: null,
        managedInstall: null,
        shell: { dirs: shell.dirs, files: shell.files },
      });
      return;
    }
    printDryRun(name, plan, shell);
    return;
  }

  const hasFileWork = plan.actions.length > 0;
  const hasShellWork = shell.files.length > 0;

  if (!hasFileWork && !hasShellWork) {
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
  // write. Delegated scopes were blocked before apply. Detect-only
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
  // Best-effort collection takes its own records lease and rechecks all references after removal.
  // A failed sweep never turns this successful uninstall into a failure.
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
function printDryRun(name: string, plan: Awaited<ReturnType<VerifiedUninstallPlanner["plan"]>>, shell: ShellCleanup): void {
  const lines = formatUninstallPlan(plan, "dry-run");
  if (lines.length === 0 && shell.files.length === 0) {
    log(`nothing tracked to remove for ${name}`);
    return;
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
