export const DEFAULT_CAPTURE_LIMITS = Object.freeze({
  maxNodes: 50_000,
  maxDepth: 128,
  maxMetadataBytes: 32 * 1024 * 1024,
  maxBackupBytes: 64 * 1024 * 1024,
  maxHashBytes: 4 * 1024 * 1024 * 1024,
  maxEvents: 50_000,
  maxAuditBytes: 16 * 1024 * 1024,
  maxAuditLines: 50_000,
  maxWorkMs: 30_000,
  maxBlobBytes: 64 * 1024 * 1024,
  maxStoreBytes: 1024 * 1024 * 1024,
});
export type CaptureLimits = { -readonly [K in keyof typeof DEFAULT_CAPTURE_LIMITS]: number };
export class CaptureLimitError extends Error {
  constructor(name: string) {
    super(`${name} requires a positive safe integer`);
    this.name = "CaptureLimitError";
  }
}
export const CAPTURE_LIMIT_ENV: Record<keyof CaptureLimits, string> = {
  maxNodes: "TRET_CAPTURE_MAX_NODES",
  maxDepth: "TRET_CAPTURE_MAX_DEPTH",
  maxMetadataBytes: "TRET_CAPTURE_MAX_METADATA_BYTES",
  maxBackupBytes: "TRET_CAPTURE_MAX_BACKUP_BYTES",
  maxHashBytes: "TRET_CAPTURE_MAX_HASH_BYTES",
  maxEvents: "TRET_CAPTURE_MAX_EVENTS",
  maxAuditBytes: "TRET_CAPTURE_MAX_AUDIT_BYTES",
  maxAuditLines: "TRET_CAPTURE_MAX_AUDIT_LINES",
  maxWorkMs: "TRET_CAPTURE_MAX_WORK_MS",
  maxBlobBytes: "TRET_CAPTURE_MAX_BLOB_BYTES",
  maxStoreBytes: "TRET_CAPTURE_MAX_STORE_BYTES",
};

export function captureLimits(env: Record<string, string | undefined> = process.env): CaptureLimits {
  const limits: CaptureLimits = { ...DEFAULT_CAPTURE_LIMITS };
  for (const key of Object.keys(CAPTURE_LIMIT_ENV) as (keyof CaptureLimits)[]) {
    const name = CAPTURE_LIMIT_ENV[key];
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new CaptureLimitError(name);
    limits[key] = Number(raw);
  }
  return Object.freeze(limits);
}

const resources = {
  nodes: "maxNodes",
  metadataBytes: "maxMetadataBytes",
  backupBytes: "maxBackupBytes",
  hashBytes: "maxHashBytes",
  events: "maxEvents",
  auditBytes: "maxAuditBytes",
  auditLines: "maxAuditLines",
} as const;
export type CaptureResource = keyof typeof resources;
export type CaptureResourceReport = { limits: CaptureLimits; used: Record<CaptureResource, number>; losses: string[] };
export function validCaptureResources(value: unknown): value is CaptureResourceReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<CaptureResourceReport>;
  return (
    !!report.limits &&
    !!report.used &&
    (Object.keys(DEFAULT_CAPTURE_LIMITS) as (keyof CaptureLimits)[]).every(
      (key) => Number.isSafeInteger(report.limits?.[key]) && report.limits![key] > 0,
    ) &&
    (Object.keys(resources) as CaptureResource[]).every(
      (key) =>
        Number.isSafeInteger(report.used?.[key]) &&
        report.used![key] >= 0 &&
        report.used![key] <= report.limits![resources[key]],
    ) &&
    Array.isArray(report.losses) &&
    report.losses.length <= 33 &&
    report.losses.every((reason) => typeof reason === "string")
  );
}

export class CaptureBudgetError extends Error {
  constructor(
    readonly resource: string,
    readonly limit: number,
  ) {
    super(`capture budget exhausted: ${resource} (limit ${limit}); unobserved state remains unknown`);
    this.name = "CaptureBudgetError";
  }
}

/** Shared across baseline, fallback attempts and close; no budget is reset by retrying. */
export class CaptureBudget {
  readonly used: Record<CaptureResource, number> = {
    nodes: 0,
    metadataBytes: 0,
    backupBytes: 0,
    hashBytes: 0,
    events: 0,
    auditBytes: 0,
    auditLines: 0,
  };
  readonly losses = new Set<string>();
  fatalError?: CaptureBudgetError;
  private deadline?: number;
  constructor(
    readonly limits: CaptureLimits = captureLimits(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Installer runtime is excluded; each active scan/hash phase has a bounded work window. */
  beginPhase(): void {
    this.deadline = this.now() + this.limits.maxWorkMs;
    this.check();
  }
  ensurePhase(): void {
    if (this.deadline === undefined) this.beginPhase();
  }
  pause(): void {
    this.deadline = undefined;
  }
  check(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.deadline !== undefined && this.now() >= this.deadline)
      this.exhaust("active work milliseconds", this.limits.maxWorkMs);
  }
  remaining(resource: CaptureResource): number {
    return this.limits[resources[resource]] - this.used[resource];
  }
  consume(resource: CaptureResource, amount: number): void {
    this.check();
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid capture resource accounting");
    if (amount > this.remaining(resource)) this.exhaust(resource, this.limits[resources[resource]]);
    this.used[resource] += amount;
  }
  tryConsume(resource: CaptureResource, amount: number): boolean {
    this.check();
    if (amount > this.remaining(resource)) {
      this.note(new CaptureBudgetError(resource, this.limits[resources[resource]]).message);
      return false;
    }
    this.consume(resource, amount);
    return true;
  }
  inspect(path: string): void {
    this.consume("nodes", 1);
    this.consume("metadataBytes", Buffer.byteLength(path) + 256);
  }
  depth(level: number): void {
    this.check();
    if (level > this.limits.maxDepth) this.exhaust("directory depth", this.limits.maxDepth);
  }
  event(event: unknown): void {
    this.consume("events", 1);
    this.consume("metadataBytes", Buffer.byteLength(JSON.stringify(event)));
  }
  note(reason: string): void {
    const bounded = reason.length > 2048 ? `${reason.slice(0, 2048)}…` : reason;
    if (this.losses.has(bounded)) return;
    if (this.losses.size < 32) this.losses.add(bounded);
    else this.losses.add("additional capture losses omitted after 32 diagnostics");
  }
  report(): CaptureResourceReport {
    return { limits: { ...this.limits }, used: { ...this.used }, losses: [...this.losses] };
  }
  private exhaust(resource: string, limit: number): never {
    this.fatalError = new CaptureBudgetError(resource, limit);
    this.note(this.fatalError.message);
    throw this.fatalError;
  }
}
