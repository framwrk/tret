import type { ApplianceOutcome, ApplyUninstallResult } from "./removal";
import { FileStorage, RecordRevisionError } from "./store";
import { VerifiedUninstallPlanner, claimedByOthers, sharedClaim } from "./uninstall-planner";
import type { DurableOperation } from "./operation-log";
import type { RecordV3 } from "../types";
import { applyNativeAction } from "./native-action";
import { cleanupClaimChecker } from "./delegated-removal";
import { normalizationDetails } from "./capture/diagnostics";
import { normalizeJournal } from "./journal/normalize";
import { reduceRecordForRetry } from "./removal";
import { traceObservations } from "./capture/trace-observations";
import { withTracedEvidence } from "./records-v4";

/** Explicit recovery replays filesystem protocol steps, never external code. */
export async function resumeOperation(storage: FileStorage, id: string): Promise<DurableOperation> {
  return storage.withOperation(async () => {
    let operation = storage.operations.claimForRecovery(id);
    const records = await storage.loadRecords();
    const application = operation.stage === "applying" ? operation.application : undefined;
    if (!application) {
      const checkpoint = operation.checkpoint;
      if (!checkpoint)
        return storage.operations.checkpoint(operation, {
          stage: "partial",
          reason: "no record checkpoint exists; retained available evidence without executing code",
        });
      const current = records.find((record) => record.id === checkpoint.id);
      const expected = operation.priorRecords.find((record) => record.id === checkpoint.id);
      const pendingTrace =
        operation.kind === "trace" &&
        operation.capture !== undefined &&
        checkpoint.capture.segments.length === expected?.capture.segments.length;
      if (current && payload(current) === payload(checkpoint) && !pendingTrace) {
        return storage.operations.checkpoint(operation, {
          stage: "partial",
          reason: "the record write already committed; recovery did not repeat external execution",
        });
      }
      const replacementRemovedPrior =
        operation.kind === "replace" &&
        operation.application !== undefined &&
        operation.application.nextAction === operation.application.plan.actions.length;
      if (
        operation.kind === "replace" &&
        current &&
        checkpoint.capture.backend === "pending" &&
        current.owned.length + current.mutated.length + current.deleted.length > 0
      )
        throw new RecordRevisionError(checkpoint.id);
      if (current ? current.revision !== expected?.revision : expected !== undefined && !replacementRemovedPrior)
        throw new RecordRevisionError(checkpoint.id);
      let available = checkpoint;
      let normalizedCapture = operation.capture;
      if (operation.capture && (checkpoint.capture.backend === "pending" || operation.kind === "trace")) {
        const effects = normalizeJournal({
          journal: operation.capture,
          caseSensitive: checkpoint.caseSensitive,
          backups: checkpoint.captureSettings?.backups ?? { enabled: false, sizeLimitBytes: 1024 * 1024 },
          availableBeforeImages: new Set(operation.pins),
        });
        const observations = operation.kind === "trace" ? traceObservations(
          operation.priorRecords.find(record => record.id === checkpoint.id) ?? checkpoint, effects, records,
        ) : undefined;
        normalizedCapture = { ...operation.capture, ...(observations ? { observations } : {}), ...normalizationDetails(effects) };
        const segments = pendingTrace
          ? [
              ...checkpoint.capture.segments,
              {
                kind: "trace" as const,
                startedAt: operation.unknownSince ?? operation.startedAt,
                ...(operation.capture.partialReason ? { partialReason: operation.capture.partialReason } : {}),
                ...(operation.capture.resources ? { resources: operation.capture.resources } : {}),
                ...(operation.execution?.roots ? { roots: operation.execution.roots } : {}),
              },
            ]
          : checkpoint.capture.segments;
        const tracked = new Set([...checkpoint.owned, ...checkpoint.mutated, ...checkpoint.deleted].map((entry) => entry.path));
        const claims = operation.kind === "trace" ? claimedByOthers(records, checkpoint.id) : undefined;
        const canMerge = (entry: { path: string }) =>
          !tracked.has(entry.path) && (!claims || !sharedClaim(claims, entry.path, checkpoint.caseSensitive));
        available = {
          ...checkpoint,
          owned: [...checkpoint.owned, ...effects.owned.filter(canMerge)],
          mutated: [...checkpoint.mutated, ...effects.mutated.filter(canMerge)],
          deleted: [...checkpoint.deleted, ...effects.deleted.filter(canMerge)],
          capture: {
            ...checkpoint.capture,
            backend: operation.kind === "trace" ? checkpoint.capture.backend : operation.capture.backend,
            segments: segments.map((segment, index, all) =>
              index === all.length - 1 ? { ...segment, ...(observations ? { observations } : {}), ...normalizationDetails(effects) } : segment,
            ),
          },
        };
      }
      let recovered: RecordV3 = {
        ...available,
        ...(current ? { revision: current.revision } : {}),
        evidence:
          operation.kind === "trace"
            ? (checkpoint.evidence ?? []).map((entry) => ({ ...entry, authority: "none" as const, approval: undefined }))
            : [],
        capture: {
          ...available.capture,
          completeness: "partial",
          segments: available.capture.segments.map((segment, index, all) =>
            index === all.length - 1
              ? {
                  ...segment,
                  ...(operation.capture ? { backend: operation.capture.backend } : {}),
                  ...(operation.execution?.exitCode === undefined ? {} : { exitCode: operation.execution.exitCode }),
                  partialReason: [segment.partialReason, "interrupted operation: only durable checkpoints are available"]
                    .filter(Boolean)
                    .join("; "),
                }
              : segment,
          ),
        },
      };
      if (operation.capture) recovered = withTracedEvidence(recovered, operation.capture, operation.kind === "trace" ? "trace" : "capture");
      if (!current) delete recovered.revision;
      await storage.saveRecord(recovered, operation.kind === "trace" ? "trace" : "capture");
      return storage.operations.checkpoint(operation, {
        stage: "partial",
        checkpoint: recovered,
        ...(normalizedCapture ? { capture: normalizedCapture } : {}),
        reason: "available evidence retained; uncaptured interval remains unknown; installer was not rerun",
      });
    }

    const prior = operation.priorRecords.find((record) => record.id === application.plan.recordId);
    if (!prior) throw new Error("application recovery requires its prior record snapshot");
    if (
      application.outcomes.some(
        (outcome) => outcome.outcome === "failed" || outcome.outcome === "conflict" || outcome.outcome === "detected",
      )
    )
      throw new Error("recorded partial actions require reconciliation and a new approved plan");
    const current = records.find((record) => record.id === prior.id);
    const result = resultFrom(application.outcomes);
    const alreadyReduced = reduceRecordForRetry(prior, result);
    if (current && current.revision !== prior.revision && payload(current) !== payload(alreadyReduced))
      throw new RecordRevisionError(prior.id);
    const pending = application.plan.actions.filter(
      (action) => !application.outcomes.some((outcome) => outcome.path === action.path),
    );
    const shared = cleanupClaimChecker(records, prior, storage.homeDir);
    if (pending.some((action) => shared(action.path)))
      throw new Error("recovery scope overlaps another record's current claim");
    if (!current && pending.some((action) => action.action === "remove" || action.action === "restore"))
      throw new RecordRevisionError(prior.id);

    for (const [index, action] of application.plan.actions.entries()) {
      if (operation.application!.outcomes.some((outcome) => outcome.path === action.path)) continue;
      let outcome: ApplianceOutcome;
      if (action.action === "skip") outcome = { path: action.path, outcome: "skipped", reason: action.reason };
      else if (action.action === "conflict" || action.action === "detected")
        throw new Error("unresolved preflight actions require a new plan");
      else {
        if (!action.approval) throw new Error("recovery action has no object-bound approval");
        const cursor = operation.application!.native?.[index];
        if (!cursor) {
          const fresh = await new VerifiedUninstallPlanner().plan(current!, {
            otherRecords: records,
            force: application.plan.force,
            getBlob: (blob) => storage.getBlob(blob),
          });
          if (!fresh.actions.some((candidate) => candidate.path === action.path && candidate.action === action.action))
            throw new Error(`recovery preflight changed: ${action.path}`);
        }
        const bytes = action.action === "restore" ? await storage.getBlob(action.beforeBlob) : undefined;
        if (
          action.action === "restore" &&
          (!bytes || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== action.beforeBlob)
        )
          throw new Error("recovery before-image is unavailable");
        await applyNativeAction({
          approval: action.approval,
          bytes,
          mode: action.action === "restore" ? action.mode : undefined,
          resume: cursor,
          checkpoint: async (receipt) => {
            operation = storage.operations.checkpoint(operation, {
              application: {
                ...operation.application!,
                native: { ...operation.application?.native, [index]: receipt },
                nextAction: index,
              },
            });
          },
        });
        outcome = { path: action.path, outcome: action.action === "restore" ? "restored" : "removed" };
      }
      operation = storage.operations.checkpoint(operation, {
        application: {
          ...operation.application!,
          outcomes: [...operation.application!.outcomes, outcome],
          nextAction: index + 1,
        },
      });
    }
    const reduced = reduceRecordForRetry(prior, resultFrom(operation.application!.outcomes));
    if (resultFrom(operation.application!.outcomes).removed.includes(reduced.executable)) reduced.executable = "";
    const remaining = reduced.owned.length + reduced.mutated.length + reduced.deleted.length;
    const keepRecord = remaining > 0 || (application.plan.retained?.length ?? 0) > 0 || operation.kind === "replace";
    if (keepRecord) {
      if (!current || payload(current) !== payload(reduced)) {
        if (current) reduced.revision = current.revision;
        else delete reduced.revision;
        await storage.saveRecord(reduced);
      }
    } else if (current) await storage.removeRecord(current.id, current.revision);
    const coverageIncomplete = application.plan.scope === "recorded-effects" && !!application.plan.coverageGaps?.length;
    return storage.operations.checkpoint(operation, {
      stage: operation.kind === "replace" || coverageIncomplete ? "partial" : "completed",
      checkpoint: reduced,
      reason:
        operation.kind === "replace"
          ? "previous cleanup reconciled; replacement installer was not rerun"
          : coverageIncomplete
            ? "tracked actions reconciled; capture gaps leave the requested scope unresolved"
            : "requested cleanup scope reconciled without repeating completed actions",
    });
  }, true);
}

function payload(record: RecordV3): string {
  const copy = { ...record };
  delete copy.revision;
  delete copy.evidence;
  return JSON.stringify(copy);
}

function resultFrom(outcomes: ApplianceOutcome[]): ApplyUninstallResult {
  return {
    outcomes,
    removed: outcomes.filter((entry) => entry.outcome === "removed").map((entry) => entry.path),
    restored: outcomes.filter((entry) => entry.outcome === "restored").map((entry) => entry.path),
    skipped: outcomes.filter((entry) => entry.outcome === "skipped").map((entry) => entry.path),
    detected: [],
    conflicts: [],
    failed: [],
    incomplete: false,
  };
}
