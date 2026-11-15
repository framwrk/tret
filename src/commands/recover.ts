import { EXIT_BLOCKED, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { RecoveryLimitError, RecoveryRetentionError } from "../lib/recovery-retention";
import { confirm, log } from "../lib/utilities";
import { discardOriginal, inspectOriginal, originalId, purgeDiscarded } from "../lib/recovery-originals";
import { emitJson, isJsonMode } from "../lib/json-output";
import { FileStorage } from "../lib/store";
import { fail } from "../lib/failure";
import { operationSummary } from "../lib/operation-log";
import { resumeOperation } from "../lib/recovery";

type RecoveryAction = "inspect" | "resume" | "discard" | "purge";
export async function recover(id: string | undefined, action: RecoveryAction, yes: boolean): Promise<void> {
  try { await runRecovery(id, action, yes); }
  catch (error) {
    if (error instanceof RecoveryLimitError) fail("recover-limits", error.message, EXIT_USAGE);
    const retention = error instanceof RecoveryRetentionError ? error : error instanceof Error && error.cause instanceof RecoveryRetentionError ? error.cause : undefined;
    fail(retention ? retention.executionMayHaveStarted ? "recovery-evidence-partial" : "recover-retention" : "recover-blocked", error instanceof Error ? error.message : String(error), retention?.executionMayHaveStarted ? EXIT_ERROR : EXIT_BLOCKED);
  }
}

async function runRecovery(id: string | undefined, action: RecoveryAction, yes: boolean): Promise<void> {
  if (action !== "inspect" && (!id || id.startsWith("--"))) fail("recover-usage", "recovery mutations require one operation id", EXIT_USAGE);
  const storage = new FileStorage();
  const limits = storage.operations.retention.limits;
  if (id?.startsWith("original-")) {
    if (!/^original-v[23]:[a-f0-9]{64}$/.test(id)) fail("recover-usage", "original selector must be original-v2:<sha256> or original-v3:<sha256>", EXIT_USAGE);
    if (action === "resume" || action === "purge") fail("recover-usage", "retained originals support inspection or --discard only", EXIT_USAGE);
    const original = inspectOriginal(storage.operations, id);
    if (!original) fail("recover-not-found", `original not found: ${id}`, EXIT_NOT_FOUND);
    if (action === "discard") {
      if (!yes && (isJsonMode() || !process.stdin.isTTY)) fail("recover-consent", "pass --yes to relinquish this original's recovery evidence; target files are unchanged", EXIT_BLOCKED);
      if (!yes && !confirm(`discard exactly ${id} (${original.bytes} bytes)? target files are unchanged [y/N]`)) fail("recover-consent", "original discard was declined", EXIT_BLOCKED);
      const discarded = await storage.withOperation(async () => discardOriginal(storage.operations, id), true);
      if (isJsonMode()) emitJson({ ok: true, command: "recover", action, original: discarded });
      else log(`discarded ${id}; target files and active records unchanged`);
    } else if (isJsonMode()) emitJson({ ok: true, command: "recover", original });
    else log(`${original.id} ${original.bytes} bytes; ${original.verified && original.formatValid ? "content address and format verified" : "INVALID content address or format — retained for manual reconciliation"}`);
    return;
  }
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail("recover-not-found", `operation not found: ${id}`, EXIT_NOT_FOUND);
  const operations = id ? [storage.operations.get(id)].filter((entry) => entry !== undefined) : storage.operations.list();
  const selected = operations;
  if (id && !selected.length) fail("recover-not-found", `operation not found: ${id}`, EXIT_NOT_FOUND);
  if (action !== "inspect") {
    if (!yes && (isJsonMode() || !process.stdin.isTTY))
      fail("recover-consent", "pass --yes to authorize this recovery decision", EXIT_BLOCKED);
    const staging = Object.values(selected[0]!.application?.native ?? {}).map(
      (receipt) => `${receipt.path}: ${receipt.stageName}`,
    ).concat(selected[0]!.retainedPaths ?? []);
    for (const path of staging) log(`retained recovery location: ${path}`);
    if (!yes && !confirm(action === "purge" ? `purge discarded receipt ${id}? target/staging files remain; only receipt metadata is deleted [y/N]` : `${action} operation ${id}? external code will not be run [y/N]`))
      fail("recover-consent", "recovery decision was declined", EXIT_BLOCKED);
    if (action === "purge") {
      const purged = await storage.withOperation(async () => purgeDiscarded(storage.operations, id!), true);
      if (isJsonMode()) emitJson({ ok: true, command: "recover", action, ...purged });
      else log(`purged discarded receipt ${id}; target and staging files unchanged`);
      return;
    }
    const operation =
      action === "resume"
        ? await resumeOperation(storage, id!)
        : await storage.withOperation(async () => storage.operations.discard(id!), true);
    if (isJsonMode()) emitJson({ ok: true, command: "recover", action, operation: operationSummary(operation) });
    else log(`${action}: ${operation.id} (${operation.stage}); ${operation.reason ?? "evidence retained"}`);
    return;
  }
  const inventory = id ? [] : storage.operations.retention.inventory();
  const originals = inventory.flatMap(entry => { const id = originalId(entry.name); return id ? [{ id, bytes: entry.size, ...(entry.kind === "corrupt" ? { interruptedDiscard: true } : {}) }] : []; });
  const unresolved = [...inventory.filter(entry => (entry.kind === "corrupt" || entry.kind === "staging") && !originalId(entry.name)), ...(id ? [] : storage.operations.unpublishedChunks(operations))].map(entry => ({ path: entry.path, kind: entry.kind, bytes: entry.size }));
  if (isJsonMode()) emitJson({ ok: true, command: "recover", operations: selected.map(operationSummary), originals, unresolved, limits });
  else {
    for (const operation of selected)
      log(`${operation.id} ${operation.kind} ${operation.stage}${operation.reason ? `: ${operation.reason}` : ""}`);
    for (const original of originals) log(`${original.id} ${original.bytes} bytes; retained original, inspect before explicit discard`);
    for (const entry of unresolved) log(`${entry.kind} evidence at ${entry.path} (${entry.bytes} bytes); manual reconciliation required`);
  }
}
