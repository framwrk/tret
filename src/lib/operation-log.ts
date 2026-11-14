import {
  PRIVATE_FILE_MODE,
  assertDirectoryIfExists,
  isErrno,
  readFileIfExists,
  writeFileAtomic,
  writeFileExclusive,
} from "./atomic";
import { dirname, join } from "node:path";
import type { ApplianceOutcome } from "./removal";
import type { CaptureBaselineEntry } from "./capture/backend";
import type { Journal } from "./capture/events";
import type { NativeActionReceipt } from "./native-action";
import type { RecordV3 } from "../types";
import type { UninstallPlan } from "./uninstall-planner";
import { currentOperationToken } from "./operation-lease";
import { isV3Record } from "./records";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { referencedBlobs } from "./storage";
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
  reason?: string;
  retainedPaths?: string[];
  execution?: { recordId: string; roots: string[]; scriptSha256?: string; executable?: string; exitCode?: number };
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
  constructor(readonly stateDir: string) {
    this.directory = join(stateDir, "operations");
  }

  /** Read-only; unrecognized entries or corrupt manifests fail closed and prevent GC. */
  list(): DurableOperation[] {
    assertDirectoryIfExists(this.stateDir);
    assertDirectoryIfExists(this.directory);
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    return names
      .filter((name) => !name.endsWith(".tmp"))
      .sort()
      .map((name) => {
        if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5)))
          throw new Error(`unrecognized recovery entry: ${join(this.directory, name)}`);
        const bytes = readFileIfExists(join(this.directory, name), MAX_OPERATION_BYTES);
        if (!bytes || bytes.byteLength > MAX_OPERATION_BYTES) throw new Error(`unreadable or oversized operation: ${name}`);
        const operation: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!validOperation(operation) || operation.id !== name.slice(0, -5))
          throw new Error(`invalid operation evidence: ${name}`);
        return operation;
      });
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
    this.write(operation, true);
    return operation;
  }

  checkpoint(
    operation: DurableOperation,
    change: Partial<
      Pick<
        DurableOperation,
        "stage" | "pins" | "checkpoint" | "baseline" | "capture" | "application" | "execution" | "unknownSince" | "reason"
      >
    >,
  ): DurableOperation {
    const owner = this.requireLease();
    if (operation.owner !== owner) throw new Error("operation belongs to a different lease; use explicit recovery");
    const current = this.list().find((entry) => entry.id === operation.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(operation))
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

  /** Evidence discard changes no target and can only run with exclusive store access. */
  discard(id: string): DurableOperation {
    const owner = this.requireLease();
    const operation = this.list().find((entry) => entry.id === id);
    if (!operation) throw new Error(`operation not found: ${id}`);
    const next: DurableOperation = {
      ...operation,
      owner,
      stage: "discarded",
      updatedAt: new Date().toISOString(),
      pins: [],
      priorRecords: [],
      reason: "recovery evidence explicitly discarded",
      retainedPaths: Object.values(operation.application?.native ?? {}).map((receipt) =>
        join(dirname(receipt.path), receipt.stageName),
      ),
    };
    delete next.checkpoint;
    delete next.baseline;
    delete next.capture;
    delete next.application;
    delete next.execution;
    this.write(next, false);
    return next;
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
    return [
      ...new Set(
        this.list().flatMap((operation) =>
          operation.stage === "discarded"
            ? []
            : [
                ...operation.pins,
                ...referencedBlobs(operation.priorRecords),
                ...referencedBlobs(operation.checkpoint ? [operation.checkpoint] : []),
              ],
        ),
      ),
    ];
  }

  private requireLease(): string {
    const token = currentOperationToken(this.stateDir);
    if (!token) throw new Error("durable operation writes require the store operation lease");
    return token;
  }

  private write(operation: DurableOperation, exclusive: boolean): void {
    if (!validOperation(operation)) throw new Error("refusing invalid durable operation");
    const text = JSON.stringify(operation, null, 2);
    if (Buffer.byteLength(text) > MAX_OPERATION_BYTES) throw new Error("operation evidence exceeds the 16 MiB limit");
    assertDirectoryIfExists(dirname(this.directory));
    const path = join(this.directory, `${operation.id}.json`);
    if (exclusive) writeFileExclusive(path, text, PRIVATE_FILE_MODE);
    else writeFileAtomic(path, text, PRIVATE_FILE_MODE);
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
        Array.isArray(operation.capture.events))) &&
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
        (operation.execution.exitCode === undefined || Number.isInteger(operation.execution.exitCode)))) &&
    (operation.unknownSince === undefined ||
      (typeof operation.unknownSince === "string" && Number.isFinite(Date.parse(operation.unknownSince))))
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
        }
      : undefined,
    exitCode: operation.execution?.exitCode,
    roots: operation.execution?.roots ?? [],
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
