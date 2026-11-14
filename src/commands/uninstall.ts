import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { FileStorage, collectUnreferencedBlobs } from "../lib/store";
import { VerifiedUninstallPlanner, formatUninstallPlan } from "../lib/uninstall-planner";
import { applyUninstallPlan, describeOutcome, reduceRecordForRetry } from "../lib/removal";
import { confirm, log } from "../lib/utilities";
import { emitJson, isJsonMode } from "../lib/json-output";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import type { RecordV3 } from "../types";
import { buildCleanupPlan } from "../lib/cleanup-plan";
import { fail } from "../lib/failure";
import { operationMatches } from "../lib/operation-log";
import { runLogPhase } from "../lib/runlog";
import { runStoreOperation } from "../lib/command-operation";

/**
 * Removes a tool by planning an evidence-based uninstall, printing exactly what it will do, then
 * applying that same plan. Dry-run prints the identical plan without touching disk. A partial run
 * keeps a reduced record so a retry only sees the paths that survived. Root-owned entries are never
 * escalated for: the plan reports that sudo is required (D8).
 */
export async function uninstall(name: string | undefined, dryRun: boolean, yes: boolean, force = false, approvedOnly = false): Promise<void> {
  if (!name || name.startsWith("--")) {
    fail("uninstall-usage", "uninstall requires a tool name: tret uninstall <name> [--dry-run] [--yes] [--force]", EXIT_USAGE);
  }

  const storage = new FileStorage();
  if (!dryRun && !storage.inOperation) return runStoreOperation(storage, () => uninstall(name, dryRun, yes, force, approvedOnly));
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
    const receipts = storage.operations.list().filter((operation) => operationMatches(operation, name!));
    if (receipts.length) fail("uninstall-evidence-only", `only recovery evidence remains; inspect ${name} or run tret recover ${receipts.at(-1)!.id}`, EXIT_BLOCKED);
    fail("uninstall-not-found", selection.message, EXIT_NOT_FOUND);
  }
  const record = selection.record;
  // The selector may be a record id; user-facing text, JSON `tool`, and PATH-line matching all use
  // the record's display name, while the id stays alongside it in JSON.
  name = record.name;

  runLogPhase("plan");
  const { plan, fullPlan, conflicts, blocked, blockedShell } = await buildCleanupPlan(record, records, {
    force, approvedOnly, getBlob: (id) => storage.getBlob(id),
  });
  if (!approvedOnly && conflicts.length) fail("uninstall-delegated-conflict", conflicts.join("\n\t"), EXIT_BLOCKED);
  if (!approvedOnly && blocked.length) fail("uninstall-delegated-unverified", `${blocked.join("; ")}; ${name} is unchanged`, EXIT_BLOCKED);
  if (!approvedOnly && blockedShell.length) fail("uninstall-shell-unverified", `shell edits have no supported edit provenance or before-image: ${blockedShell.join(", ")}; manual reconciliation is required; ${name} is unchanged`, EXIT_BLOCKED);
  const scope = plan.scope!;
  const retained = plan.retained!;
  if (approvedOnly && plan.actions.length === 0 && (fullPlan.actions.length > 0 || retained.length > 0)) fail("uninstall-unapproved", "no current candidate has a cleanup approval; use tret approve <tool> <path> --remove or --restore", EXIT_BLOCKED);

  if (dryRun) {
    if (isJsonMode()) {
      emitJson({
        ok: !plan.incomplete,
        command: "uninstall",
        dryRun: true,
        tool: name,
        id: record.id,
        scope, retained, incomplete: plan.incomplete,
        actions: plan.actions.map((action) => {
          if (action.action !== "remove" && action.action !== "restore") return action;
          return { action: action.action, path: action.path, kind: action.kind };
        }),
        requiresSudo: plan.requiresSudo,
        managedPackage: null,
        managedInstall: null,
        shell: { dirs: [], files: [] },
      });
      if (plan.incomplete) process.exit(EXIT_BLOCKED);
      return;
    }
    printDryRun(name, plan);
    if (plan.incomplete) fail("uninstall-preflight", "cleanup is blocked; resolve the conflicts or explicitly select an approved scope", EXIT_BLOCKED);
    return;
  }

  if (plan.incomplete) {
    printDryRun(name, plan);
    fail("uninstall-preflight", "cleanup is blocked; targets were preserved; approve exact actions or resolve the reported conflicts", EXIT_BLOCKED);
  }
  if (plan.requiresSudo && process.getuid?.() !== 0) fail("uninstall-privilege", "the requested scope requires root privileges; no targets were changed", EXIT_BLOCKED);

  const hasFileWork = plan.actions.length > 0;

  if (!hasFileWork) {
    const emptyOperation = storage.operations.begin("uninstall", [record]);
    await storage.removeRecord(record.id, record.revision);
    storage.operations.checkpoint(emptyOperation, { stage: "completed", reason: "no recorded target actions; historical evidence retained" });
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
  await storage.prepareCurrentFormat();
  let operation = storage.operations.begin("uninstall", [record]);
  operation = storage.operations.checkpoint(operation, { stage: "applying", application: { plan, outcomes: [], nextAction: 0 } });
  const result = await applyUninstallPlan(plan, {
    storage,
    beforeAction: async (index) => {
      operation = storage.operations.checkpoint(operation, { application: { ...operation.application!, plan, outcomes: operation.application?.outcomes ?? [], nextAction: index } });
    },
    afterAction: async (index, outcomes) => {
      operation = storage.operations.checkpoint(operation, { application: { ...operation.application!, plan, outcomes: [...outcomes], nextAction: index + 1 } });
    },
    nativeCheckpoint: async (index, receipt) => {
      operation = storage.operations.checkpoint(operation, { application: { ...operation.application!, native: { ...operation.application?.native, [index]: receipt } } });
    },
  });
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

  const incomplete = result.incomplete;
  if (incomplete) {
    const reduced = reduceRecordForRetry(record, result);
    await persistRetry(storage, reduced);
    storage.operations.checkpoint(operation, { stage: "partial", checkpoint: reduced });
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
        failedShell: [],
      });
      process.exit(EXIT_ERROR);
    }
    if (plan.requiresSudo) {
      log("\tsome entries are root-owned; re-run with sudo to remove them");
    }
    fail("uninstall-incomplete", "some paths were not removed and stay tracked; run tret uninstall again to retry");
  }

  const remaining = reduceRecordForRetry(record, result);
  if (remaining.owned.length + remaining.mutated.length + remaining.deleted.length > 0 || retained.length > 0) await storage.saveRecord(remaining);
  else await storage.removeRecord(record.id, record.revision);
  storage.operations.checkpoint(operation, { stage: "completed", checkpoint: remaining });
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
      scope, retained,
      removed,
      restored,
      cleanedShell: [],
      outcomes: result.outcomes,
    });
    return;
  }
  log(`completed ${scope} cleanup for ${name}`);
  if (retained.length > 0) log(`\tretained ${retained.length} candidate effects outside the requested scope; inspect ${name} for details`);
}

/** Prints the same actions the real run will apply, with no side effects. */
function printDryRun(name: string, plan: Awaited<ReturnType<VerifiedUninstallPlanner["plan"]>>): void {
  const lines = formatUninstallPlan(plan, "dry-run");
  if (lines.length === 0) {
    log(`nothing tracked to remove for ${name}`);
    return;
  }

  for (const line of lines) {
    log(`\t${line}`);
  }
  for (const entry of plan.retained ?? []) log(`\tretain ${entry.path} (${entry.reason})`);

  if (plan.requiresSudo) {
    log("\tnote: some entries are root-owned; re-run with sudo to remove them");
  }
}

/**
 * Saves the reduced record, or drops it when nothing is left to retry.
 */
async function persistRetry(storage: FileStorage, reduced: RecordV3): Promise<void> {
  const remaining = reduced.owned.length + reduced.mutated.length + reduced.deleted.length;
  if (remaining === 0) {
    await storage.removeRecord(reduced.id, reduced.revision);
    return;
  }
  await storage.saveRecord(reduced);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
