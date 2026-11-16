import { type CaptureResourceReport, validCaptureResources } from "./capture/budget";
import { OPERATION_INLINE_BYTES, type OperationEnvelope, chunkName, chunkOwner, isEnvelope, operationText, prepareEnvelope, readEnvelope, removeOperationChunks } from "./operation-chunks";
import {
  PRIVATE_FILE_MODE,
  assertDirectoryIfExists,
  readFileIfExists,
  temporaryPath,
  writeFileAtomic,
  writeFileExclusive,
} from "./atomic";
import { type RecoveryEntry, type RecoveryLimits, RecoveryRetention, RecoveryRetentionError } from "./recovery-retention";
import { basename, dirname, join } from "node:path";
import type { ApplianceOutcome } from "./removal";
import type { CaptureBaselineEntry } from "./capture/backend";
import type { Journal } from "./capture/events";
import type { NativeActionReceipt } from "./native-action";
import { NativeDirectory } from "./native-filesystem";
import type { RecordV3 } from "../types";
import type { UninstallPlan } from "./uninstall-planner";
import { currentOperationToken } from "./operation-lease";
import { isV3Record } from "./records";
import { randomUUID } from "node:crypto";
import { referencedBlobs } from "./storage";
import { rmSync } from "node:fs";
import { validCaptureDiagnostics } from "./capture/diagnostics";
import { validCleanupApproval } from "./cleanup-authority";
import { validNativeReceipt } from "./native-action";

export type OperationStage = "prepared" | "running" | "captured" | "applying" | "completed" | "partial" | "discarded";
export type DurableOperation = {
  version: 1;
  id: string;
  kind: "install" | "replace" | "trace" | "uninstall" | "metadata";
  stage: OperationStage;
  startedAt: string;
  updatedAt: string;
  owner: string;
  priorRecords: RecordV3[];
  pins: string[];
  checkpoint?: RecordV3;
  baseline?: readonly CaptureBaselineEntry[];
  capture?: Omit<Journal, "beforeImages">;
  application?: {
    plan: UninstallPlan;
    outcomes: ApplianceOutcome[];
    nextAction: number;
    native?: Record<string, NativeActionReceipt>;
  };
  /** Describes evidence loss; never stores script text, profile bytes or credentials. */
  unknownSince?: string;
  /** Start of the latest durable prefix sample, never a completeness watermark. */
  checkpointAt?: string;
  reason?: string;
  retainedPaths?: string[];
  execution?: { recordId: string; roots: string[]; scriptSha256?: string; executable?: string; exitCode?: number; resources?: CaptureResourceReport };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STAGES: OperationStage[] = ["prepared", "running", "captured", "applying", "completed", "partial", "discarded"];
const MAX_OPERATION_BYTES = 16 * 1024 * 1024;

export class OperationRecoveryRequiredError extends Error {
  constructor(readonly ids: string[]) {
    super(`unfinished operations require explicit recovery: ${ids.join(", ")}`);
    this.name = "OperationRecoveryRequiredError";
  }
}

/** Durable evidence lives independently of an active record, including during replacements. */
export class OperationLog {
  readonly directory: string;
  readonly retention: RecoveryRetention;
  constructor(readonly stateDir: string, limits?: RecoveryLimits) {
    this.directory = join(stateDir, "operations");
    this.retention = new RecoveryRetention(stateDir, limits);
  }

  /** Read-only; unrecognized entries or corrupt manifests fail closed and prevent GC. */
  list(): DurableOperation[] {
    assertDirectoryIfExists(this.stateDir);
    assertDirectoryIfExists(this.directory);
    const names = this.retention.inventory().filter(entry => entry.path.startsWith(this.directory + "/")).map(entry => entry.name);
    return names
      .filter((name) => !name.endsWith(".tmp") && !chunkOwner(name))
      .sort()
      .map((name) => {
        if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) throw new Error(`unrecognized recovery entry: ${name}`);
        const operation = this.get(name.slice(0, -5)); if (!operation) throw new Error(`unreadable operation: ${name}`); return operation;
      });
  }

  /** An exact id remains inspectable/discardable even when aggregate listing refuses. */
  get(id: string): DurableOperation | undefined {
    if (!UUID.test(id)) throw new Error(`invalid operation id: ${id}`);
    assertDirectoryIfExists(this.stateDir);
    assertDirectoryIfExists(this.directory);
    const bytes = readFileIfExists(join(this.directory, `${id}.json`), MAX_OPERATION_BYTES);
    if (!bytes) return undefined;
    const stored: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const operation: unknown = isEnvelope(stored, id) ? readEnvelope(this.directory, stored) : stored;
    if (!validOperation(operation) || operation.id !== id) throw new Error(`invalid operation evidence: ${id}.json`);
    return operation;
  }

  requireReconciled(): void {
    const unfinished = this.list().filter(
      (operation) =>
        !terminal(operation.stage) ||
        Object.values(operation.application?.native ?? {}).some((receipt) => receipt.step !== "finished"),
    );
    if (unfinished.length) throw new OperationRecoveryRequiredError(unfinished.map((operation) => operation.id));
  }

  begin(kind: DurableOperation["kind"], priorRecords: RecordV3[] = []): DurableOperation {
    const owner = this.requireLease();
    this.requireReconciled();
    this.retention.beforeIntent();
    const now = new Date().toISOString();
    const operation: DurableOperation = {
      version: 1,
      id: randomUUID(),
      kind,
      stage: "prepared",
      startedAt: now,
      updatedAt: now,
      owner,
      priorRecords,
      pins: referencedBlobs(priorRecords),
    };
    // Publish an addressable intent before creating any parts. A failed initial snapshot
    // therefore has an exact id for explicit inspection/disposal, with no installer run.
    if (Buffer.byteLength(JSON.stringify(operation)) > OPERATION_INLINE_BYTES) {
      this.write({ ...operation, priorRecords: [], pins: [] }, true);
      this.write(operation, false);
    } else this.write(operation, true);
    return operation;
  }

  checkpoint(
    operation: DurableOperation,
    change: Partial<
      Pick<
        DurableOperation,
        "stage" | "pins" | "checkpoint" | "baseline" | "capture" | "application" | "execution" | "unknownSince" | "checkpointAt" | "reason"
      >
    >,
  ): DurableOperation {
    const owner = this.requireLease();
    if (operation.owner !== owner) throw new Error("operation belongs to a different lease; use explicit recovery");
    try {
      const current = this.list().find((entry) => entry.id === operation.id);
      if (!current || operationText(current) !== operationText(operation))
        throw new Error("operation checkpoint changed; reload recovery evidence");
      if (terminal(operation.stage)) throw new Error("a completed operation cannot be resumed");
      const allowed: Record<string, OperationStage[]> = {
        prepared: ["prepared", "running", "applying", "completed", "partial"],
        running: ["running", "captured", "partial", ...(operation.kind === "metadata" ? ["completed" as const] : [])],
        captured: ["captured", "applying", "completed", "partial"],
        applying: ["applying", "completed", "partial", ...(operation.kind === "replace" ? ["running" as const] : [])],
      };
      if (change.stage && !allowed[operation.stage]?.includes(change.stage))
        throw new Error("invalid operation stage transition");
      const next: DurableOperation = {
        ...operation,
        ...change,
        updatedAt: new Date().toISOString(),
        pins: [
          ...new Set([
            ...operation.pins,
            ...(change.pins ?? []),
            ...referencedBlobs(change.checkpoint ? [change.checkpoint] : []),
          ]),
        ],
      };
      if (next.stage === "completed")
        next.pins = [
          ...new Set([...referencedBlobs(next.priorRecords), ...referencedBlobs(next.checkpoint ? [next.checkpoint] : [])]),
        ];
      this.write(next, false);
      return next;
    }
    catch (error) {
      if (error instanceof RecoveryRetentionError && ["running", "captured", "applying"].includes(operation.stage)) error.executionMayHaveStarted = true;
      throw error;
    }
  }

  /** Evidence discard changes no target and can only run with exclusive store access. */
  discard(id: string): DurableOperation {
    const owner = this.requireLease();
    const operation = this.get(id);
    if (!operation) throw new Error(`operation not found: ${id}`);
    const next: DurableOperation = {
      ...operation,
      owner,
      stage: "discarded",
      updatedAt: new Date().toISOString(),
      pins: [],
      priorRecords: [],
      reason: operation.stage === "discarded" ? operation.reason : "recovery evidence explicitly discarded",
      retainedPaths: [...new Set([...(operation.retainedPaths ?? []), ...Object.values(operation.application?.native ?? {}).map((receipt) =>
        join(dirname(receipt.path), receipt.stageName),
      )])],
    };
    delete next.checkpoint;
    delete next.baseline;
    delete next.capture;
    delete next.application;
    delete next.execution;
    this.write(next, false, true);
    this.removeDiscardedChunks(id);
    return next;
  }

  /** A bounded audit tombstone precedes explicit historical-original deletion. */
  recordEvidenceDiscard(reason: string, retainedPaths: string[]): DurableOperation {
    const now = new Date().toISOString();
    const operation: DurableOperation = { version: 1, id: randomUUID(), kind: "metadata", stage: "discarded", startedAt: now, updatedAt: now, owner: this.requireLease(), priorRecords: [], pins: [], reason, retainedPaths };
    this.write(operation, true, true);
    return operation;
  }

  /** The exclusive kernel lease, rather than a PID or timestamp, establishes recovery access. */
  claimForRecovery(id: string): DurableOperation {
    const owner = this.requireLease();
    const operation = this.list().find((entry) => entry.id === id);
    if (!operation) throw new Error(`operation not found: ${id}`);
    if (terminal(operation.stage)) throw new Error("this operation already has a terminal receipt");
    const others = this.list().filter((entry) => entry.id !== id && !terminal(entry.stage));
    if (others.length) throw new OperationRecoveryRequiredError(others.map((entry) => entry.id));
    const next = { ...operation, owner, updatedAt: new Date().toISOString() };
    this.write(next, false);
    return next;
  }

  /** A discarded receipt relinquishes references; all other receipts retain them. */
  pinnedBlobs(): string[] {
    const operations = this.list();
    const historicalPins: string[] = [];
    for (const operation of operations) {
      const envelope = this.envelope(operation.id);
      if (operation.stage === "discarded") continue;
      historicalPins.push(...(envelope?.pins ?? []));
    }
    const discarded = new Set(operations.filter(op => op.stage === "discarded").map(op => op.id));
    const unknown = this.unpublishedChunks(operations).find(entry => !discarded.has(chunkOwner(entry.name)!));
    if (unknown) throw new Error(`unpublished operation chunk pins an unknown graph: ${unknown.path}; inspect/discard its operation ${chunkOwner(unknown.name)}`);
    return [
      ...new Set(
        [...historicalPins, ...operations.flatMap((operation) =>
          operation.stage === "discarded"
            ? []
            : [
                ...operation.pins,
                ...referencedBlobs(operation.priorRecords),
                ...referencedBlobs(operation.checkpoint ? [operation.checkpoint] : []),
              ],
        )],
      ),
    ];
  }

  unpublishedChunks(operations = this.list()): RecoveryEntry[] {
    const known = new Set<string>();
    for (const operation of operations)
      for (const part of this.envelope(operation.id)?.retained ?? []) known.add(chunkName(operation.id, part.hash));
    return this.retention.inventory().filter(entry => {
      const owner = chunkOwner(entry.name);
      return owner && !known.has(entry.name);
    });
  }

  removeDiscardedChunks(id: string): void {
    this.requireLease();
    if (this.get(id)?.stage !== "discarded") throw new Error("only explicitly discarded operation chunks can be removed");
    removeOperationChunks(this.directory, id, this.retention.limits.maxWorkMs);
  }

  private envelope(id: string): OperationEnvelope | undefined {
    const bytes = readFileIfExists(join(this.directory, `${id}.json`), MAX_OPERATION_BYTES);
    if (!bytes) return undefined;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isEnvelope(value, id)) return value;
    if (!validOperation(value) || value.id !== id) throw new Error(`invalid operation evidence: ${id}.json`);
    return undefined;
  }

  private requireLease(): string {
    const token = currentOperationToken(this.stateDir);
    if (!token) throw new Error("durable operation writes require the store operation lease");
    return token;
  }

  private write(operation: DurableOperation, exclusive: boolean, discard = false): void {
    const previous = exclusive ? undefined : this.envelope(operation.id);
    // Chunked generations remain retained evidence until explicit discard; expose their
    // conservative pins in the ordinary receipt summary as well as the GC graph.
    if (!discard && previous?.retained.length) operation.pins = [...new Set([...previous.pins, ...operation.pins])];
    if (!validOperation(operation)) throw new Error("refusing invalid durable operation");
    assertDirectoryIfExists(dirname(this.directory));
    const path = join(this.directory, `${operation.id}.json`);
    // Explicit discard needs no payload chunks or history, even above a lowered quota.
    const envelope = discard
      ? { version: 2, id: operation.id, inline: operation, bytes: Buffer.byteLength(JSON.stringify(operation)), retained: [], pins: [] }
      : prepareEnvelope(this.directory, operation.id, operation, [...operation.pins, ...referencedBlobs(operation.priorRecords), ...referencedBlobs(operation.checkpoint ? [operation.checkpoint] : [])], previous, this.retention);
    const text = JSON.stringify(envelope);
    if (Buffer.byteLength(text) > MAX_OPERATION_BYTES) throw new Error("operation manifest exceeds the 16 MiB limit");
    if (discard) {
      if (exclusive && Buffer.byteLength(text) > 64 * 1024) throw new Error("new discard tombstone exceeds 64 KiB; evidence retained");
    } else this.retention.beforeWrite(path, Buffer.byteLength(text));
    if (exclusive) publishExclusive(path, text);
    else writeFileAtomic(path, text, PRIVATE_FILE_MODE);
  }
}

/** Publish a flushed first manifest with no visible in-place write and no replacement authority. */
function publishExclusive(path: string, text: string): void {
  const stage = temporaryPath(path);
  writeFileExclusive(stage, text, PRIVATE_FILE_MODE);
  let directory: NativeDirectory | undefined;
  try {
    directory = new NativeDirectory(dirname(path));
    directory.moveExclusive(basename(stage), directory, basename(path));
    directory.sync();
  } finally {
    directory?.close();
    rmSync(stage, { force: true });
  }
}

function terminal(stage: OperationStage): boolean {
  return stage === "completed" || stage === "partial" || stage === "discarded";
}

function validOperation(value: unknown): value is DurableOperation {
  if (typeof value !== "object" || value === null) return false;
  const operation = value as Partial<DurableOperation>;
  return (
    operation.version === 1 &&
    typeof operation.id === "string" &&
    UUID.test(operation.id) &&
    typeof operation.owner === "string" &&
    UUID.test(operation.owner) &&
    ["install", "replace", "trace", "uninstall", "metadata"].includes(String(operation.kind)) &&
    STAGES.includes(operation.stage as OperationStage) &&
    typeof operation.startedAt === "string" &&
    Number.isFinite(Date.parse(operation.startedAt)) &&
    typeof operation.updatedAt === "string" &&
    Number.isFinite(Date.parse(operation.updatedAt)) &&
    Array.isArray(operation.priorRecords) &&
    operation.priorRecords.every(isV3Record) &&
    Array.isArray(operation.pins) &&
    operation.pins.every((pin) => typeof pin === "string" && HASH.test(pin)) &&
    (operation.checkpoint === undefined || isV3Record(operation.checkpoint)) &&
    (operation.baseline === undefined ||
      (Array.isArray(operation.baseline) &&
        operation.baseline.every(
          (entry) =>
            typeof entry.path === "string" &&
            entry.path.startsWith("/") &&
            ["file", "directory", "symlink", "unknown"].includes(entry.kind),
        ))) &&
    (operation.capture === undefined ||
      (typeof operation.capture.backend === "string" &&
        ["complete", "partial", "heuristic"].includes(operation.capture.completeness) &&
        Array.isArray(operation.capture.events) &&
        (operation.capture.resources === undefined || validCaptureResources(operation.capture.resources)) &&
        (operation.capture.normalization === undefined || validCaptureDiagnostics(operation.capture.normalization)))) &&
    (operation.application === undefined || validApplication(operation.application)) &&
    (operation.reason === undefined || typeof operation.reason === "string") &&
    (operation.retainedPaths === undefined ||
      (Array.isArray(operation.retainedPaths) &&
        operation.retainedPaths.every((path) => typeof path === "string" && path.startsWith("/")))) &&
    (operation.execution === undefined ||
      (typeof operation.execution.recordId === "string" &&
        operation.execution.recordId.length > 0 &&
        Array.isArray(operation.execution.roots) &&
        operation.execution.roots.every((path) => typeof path === "string" && path.startsWith("/")) &&
        (operation.execution.resources === undefined || validCaptureResources(operation.execution.resources)) &&
        (operation.execution.exitCode === undefined || Number.isInteger(operation.execution.exitCode)))) &&
    (operation.unknownSince === undefined ||
      (typeof operation.unknownSince === "string" && Number.isFinite(Date.parse(operation.unknownSince)))) &&
    (operation.checkpointAt === undefined ||
      (typeof operation.checkpointAt === "string" && Number.isFinite(Date.parse(operation.checkpointAt))))
  );
}

function validApplication(application: NonNullable<DurableOperation["application"]>): boolean {
  if (
    !application ||
    !application.plan ||
    !Array.isArray(application.plan.actions) ||
    !Array.isArray(application.outcomes) ||
    !Number.isSafeInteger(application.nextAction) ||
    application.nextAction < 0 ||
    application.nextAction > application.plan.actions.length
  )
    return false;
  const actions = application.plan.actions;
  if (
    !actions.every((action) => {
      if (
        !action ||
        typeof action.path !== "string" ||
        !action.path.startsWith("/") ||
        action.path.includes("\0") ||
        action.path.split("/").includes("..")
      )
        return false;
      if (action.action === "skip" || action.action === "conflict") return typeof action.reason === "string";
      if (action.action === "detected") return action.kind === "mutated" || action.kind === "deleted";
      if (action.action !== "remove" && action.action !== "restore") return false;
      if (!validCleanupApproval(action.approval, action.path) || action.approval.action !== action.action) return false;
      return (
        action.action !== "restore" ||
        (HASH.test(action.beforeBlob) &&
          (action.mode === undefined || (Number.isInteger(action.mode) && action.mode >= 0 && action.mode <= 0o777)))
      );
    })
  )
    return false;
  if (
    !application.outcomes.every(
      (outcome) =>
        outcome &&
        actions.some((action) => action.path === outcome.path) &&
        ["removed", "restored", "skipped", "detected", "conflict", "failed"].includes(outcome.outcome),
    )
  )
    return false;
  return (
    application.native === undefined ||
    (typeof application.native === "object" &&
      application.native !== null &&
      Object.entries(application.native).every(
        ([index, receipt]) =>
          /^(0|[1-9][0-9]*)$/.test(index) && validNativeReceipt(receipt) && actions[Number(index)]?.path === receipt.path,
      ))
  );
}

export function operationMatches(operation: DurableOperation, selector: string): boolean {
  return (
    operation.id === selector ||
    [...operation.priorRecords, ...(operation.checkpoint ? [operation.checkpoint] : [])].some(
      (record) => record.id === selector || record.name === selector,
    )
  );
}

/** User-facing metadata excludes before-image bytes, script arguments and full baseline contents. */
export function operationSummary(operation: DurableOperation) {
  return {
    id: operation.id,
    kind: operation.kind,
    stage: operation.stage,
    startedAt: operation.startedAt,
    updatedAt: operation.updatedAt,
    reason: operation.reason,
    unknownSince: operation.unknownSince,
    checkpointAt: operation.checkpointAt,
    tools: [
      ...new Set(
        [...operation.priorRecords, ...(operation.checkpoint ? [operation.checkpoint] : [])].map((record) => record.name),
      ),
    ],
    pinnedBlobs: operation.pins.length,
    baselineEntries: operation.baseline?.length ?? 0,
    capture: operation.capture
      ? {
          backend: operation.capture.backend,
          completeness: operation.capture.completeness,
          partialReason: operation.capture.partialReason,
          events: operation.capture.events.length,
          ...(operation.capture.normalization ? { normalization: operation.capture.normalization } : {}),
        }
      : undefined,
    exitCode: operation.execution?.exitCode,
    roots: operation.execution?.roots ?? [],
    resources: operation.capture?.resources ?? operation.execution?.resources,
    scriptSha256: operation.execution?.scriptSha256,
    staging: Object.values(operation.application?.native ?? {}).map((receipt) => ({
      path: receipt.path,
      directory: receipt.stageName,
      step: receipt.step,
      reason: receipt.reason,
    })),
    retainedPaths: operation.retainedPaths ?? [],
    scope: operation.application?.plan.scope,
    retained: operation.application?.plan.retained ?? [],
  };
}
