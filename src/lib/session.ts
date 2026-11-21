import type { AbsolutePath, CaptureCompleteness, CaptureSegment, Privilege } from "../types";
import type { CaptureBackend, CaptureCommand, CaptureSession } from "./capture/backend";
import type { BackupPolicy } from "./capture/normalize";
import type { CaptureBudget } from "./capture/budget";
import { CaptureBudgetError } from "./capture/budget";
import type { Journal } from "./capture/events";

export const LIVE_CHECKPOINT_INTERVAL_MS = 1000;
export const MAX_LIVE_CHECKPOINTS = 32;

/**
 * One bounded observation window: which backend ran, how completely it attributed changes, when the
 * window opened and closed, and how much it saw. The `segment` is record-shaped, so a caller can
 * attach it to a record without a format migration (D5).
 */
export type SessionCoverage = {
  /** Backend identifier, mirrored from the journal (`record.capture.backend`). */
  backend: string;
  /** How much of the process tree the backend could prove; never assumed complete. */
  completeness: CaptureCompleteness;
  /** Present when attribution is not complete; explains the blind spot. */
  partialReason?: string;
  /** The record segment this window would attach, with any incompleteness recorded on it. */
  segment: CaptureSegment;
  /** Number of journal events the backend observed. */
  events: number;
  /** Absolute roots the backend was asked to observe. */
  roots: AbsolutePath[];
};

/** The outcome of one bounded capture session: the observed work plus what capture saw. */
export type BoundedSessionResult<T> = {
  /** The value the observed work resolved to, or `undefined` when it threw. */
  value?: T;
  /** The error the observed work threw, if any. Capture is closed before this is returned. */
  error?: unknown;
  /** Capture/persistence failed after execution; callers must report partial failure, not success. */
  captureError?: unknown;
  /** The closed journal, or the latest available partial prefix when close fails. */
  journal: Journal;
  coverage: SessionCoverage;
};

export type BoundedSessionOptions<T> = {
  budget?: CaptureBudget;
  /** The capture mechanism to attach for the window. */
  backend: CaptureBackend;
  /**
   * Process id whose descendants the backend observes. A caller that runs the work as a child passes
   * its own pid, so capture can start before the child exists and the child is still inside the tree.
   */
  pid: number;
  command?: CaptureCommand;
  /** Privilege the observed work runs under, for sudo-aware coverage (D8). */
  privilege: Privilege;
  /** Absolute roots to observe, already expanded from the active platform table. */
  roots: AbsolutePath[];
  /** Before-image backup policy (D2); off by default, so no content is captured unless opted in. */
  backups?: BackupPolicy;
  /** The bounded work to run while capture is attached. */
  run: (session: CaptureSession) => Promise<T>;
  /** Durable barrier after baseline/attach, before external work. A failure never triggers fallback. */
  beforeRun?: (session: CaptureSession) => Promise<void>;
  /** Persists an available partial prefix while external work is running. */
  onCheckpoint?: (journal: Journal, observedAt: string) => Promise<void>;
  /** Internal test seam; production samples at one second, at most 32 changed prefixes. */
  checkpointIntervalMs?: number;
  /** Clock in milliseconds; injectable so tests can pin the window. */
  now?: () => number;
  /** Which kind of window this is; defaults to "install" (`trace` is reserved by D5 for later). */
  kind?: CaptureSegment["kind"];
};

export class BeforeExecutionError extends Error {
  constructor(cause: unknown) {
    super(`pre-execution persistence failed: ${message(cause)}`, { cause });
    this.name = "BeforeExecutionError";
  }
}

/**
 * Runs one bounded capture session: attach the backend, run the work, close the window, and report
 * what was observed. This is the Phase 8 replacement for the implicit `--help` first run: the
 * observed work is the install window (or a later explicit run), not an arbitrary tool invocation,
 * and the window and its coverage are always reported.
 *
 * Boundary guarantees:
 * - Capture starts before `run`, so the work is inside the observed tree and no window is claimed
 *   that capture did not cover.
 * - A backend that cannot attach throws here, before `run`, so a failed attach never silently runs
 *   the work unwatched. Callers that can proceed without capture must catch this and say so.
 * - `stop()` runs even when the work throws, so a bounded session never leaks a tracer; a stop
 *   failure is reported as `partial` coverage instead of throwing, so the work is never re-run.
 */
export async function runBoundedSession<T>(options: BoundedSessionOptions<T>): Promise<BoundedSessionResult<T>> {
  const clock = options.now ?? Date.now;
  const startedAt = new Date(clock()).toISOString();
  options.budget?.beginPhase();

  const session = await options.backend.start({
    pid: options.pid,
    ...(options.command ? { command: options.command } : {}),
    privilege: options.privilege,
    roots: options.roots,
    // Omit the key entirely when no policy is supplied, so a plain window's start options stay exact.
    ...(options.backups === undefined ? {} : { backups: options.backups }),
    ...(options.budget ? { budget: options.budget } : {}),
  });

  try {
    options.budget?.ensurePhase();
    await options.beforeRun?.(session);
    options.budget?.check();
  } catch (error) {
    try { await session.stop(); } catch { /* No external work ran. Preserve the barrier failure. */ }
    if (error instanceof CaptureBudgetError) throw error;
    throw new BeforeExecutionError(error);
  }

  try { await session.ready?.(); options.budget?.check(); }
  catch (error) {
    try { await session.stop(); } catch { /* Preserve the pre-execution attachment failure. */ }
    throw error;
  }

  let value: T | undefined;
  let error: unknown;
  let captureError: unknown;
  let prefix: Journal | undefined;
  let publishedSignature: string | undefined;
  let publications = 0;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const schedule = () => {
    if (finished || captureError !== undefined || publications >= MAX_LIVE_CHECKPOINTS || !session.checkpoint || !options.onCheckpoint) return;
    timer = setTimeout(() => { inFlight = checkpoint(); }, options.checkpointIntervalMs ?? LIVE_CHECKPOINT_INTERVAL_MS);
  };
  const checkpoint = async () => {
    try {
      const observedAt = new Date(clock()).toISOString();
      options.budget?.beginPhase();
      const available = await session.checkpoint!();
      if (available) {
        prefix = { ...available, completeness: "partial", events: available.events.slice() };
        const signature = `${prefix.events.length}:${prefix.partialReason ?? ""}`;
        if (signature !== publishedSignature) {
          await options.onCheckpoint!(prefix, observedAt);
          options.budget?.check();
          publishedSignature = signature;
          publications++;
        }
      }
    } catch (caught) { captureError = caught instanceof Error ? caught : new Error(String(caught)); }
    finally { options.budget?.pause(); }
    schedule();
  };
  options.budget?.pause();
  schedule();
  try {
    value = await options.run(session);
  } catch (caught) {
    error = caught;
  }
  finished = true;
  clearTimeout(timer);
  await inFlight;

  let journal: Journal;
  let budgetError: unknown;
  try { options.budget?.beginPhase(); } catch (caught) { budgetError = caught; }
  try {
    journal = await session.stop();
  } catch (caught) {
    // Closing is part of the window. A backend that fails to close leaves attribution partial, not
    // green: report the blind spot and keep whatever the work produced.
    captureError ??= caught;
    // A backend may still expose parsed evidence after detaching/closing failed.
    try {
      const available = await session.checkpoint?.();
      if (available) prefix = { ...available, completeness: "partial", events: available.events.slice() };
    } catch { /* Preserve the last available prefix and the original close failure. */ }
    journal = {
      ...prefix,
      backend: session.backend,
      completeness: "partial",
      partialReason: [prefix?.partialReason, `capture failed to close: ${message(caught)}`].filter(Boolean).join("; "),
      events: prefix?.events ?? [],
    };
  }
  options.budget?.pause();
  if (prefix?.events.length) {
    const key = (event: Journal["events"][number]) => JSON.stringify([event.type, event.at, event.pid,
      ...(event.type === "rename" ? [event.from, event.to] : [event.path])]);
    const remaining = new Map<string, number>();
    for (const event of journal.events) remaining.set(key(event), (remaining.get(key(event)) ?? 0) + 1);
    const missing = prefix.events.filter(event => {
      const count = remaining.get(key(event)) ?? 0;
      if (!count) return true;
      remaining.set(key(event), count - 1);
      return false;
    });
    if (missing.length) {
      const reason = "closed capture omitted earlier observations; retained available prefix evidence";
      captureError ??= new Error(reason);
      journal = { ...journal, events: [...missing, ...journal.events].sort((a, b) => a.at - b.at || a.seq - b.seq).map((event, seq) => ({ ...event, seq })),
        partialReason: [journal.partialReason, prefix.partialReason, reason].filter(Boolean).join("; ") };
    }
  }
  captureError ??= budgetError;
  if (!journal.beforeImages && session.beforeImages?.size) journal.beforeImages = new Map(session.beforeImages);
  if (captureError !== undefined) {
    journal.completeness = "partial";
    journal.partialReason = [...new Set([journal.partialReason, `capture checkpoint or close failed: ${message(captureError)}`].filter(Boolean))].join("; ");
  }
  if (options.budget) {
    journal.resources = options.budget.report();
    const losses = [...options.budget.losses, ...(budgetError ? [message(budgetError)] : [])];
    if (losses.length) {
      if (journal.completeness === "complete") journal.completeness = "partial";
      journal.partialReason = [...new Set([journal.partialReason, ...losses.filter((loss) => !journal.partialReason?.includes(loss))].filter(Boolean))].join("; ");
    }
  }

  const endedAt = new Date(clock()).toISOString();
  return {
    value,
    error,
    ...(captureError === undefined ? {} : { captureError }),
    journal,
    coverage: {
      backend: journal.backend,
      completeness: journal.completeness,
      ...(journal.partialReason === undefined ? {} : { partialReason: journal.partialReason }),
      segment: { ...buildCaptureSegment({ kind: options.kind ?? "install", startedAt, endedAt, journal }), ...(options.budget ? { roots: [...options.roots] } : {}) },
      events: journal.events.length,
      roots: [...options.roots],
    },
  };
}

/** Builds the record-shaped segment for one window; incomplete capture always carries a reason. */
export function buildCaptureSegment(input: {
  kind: CaptureSegment["kind"];
  startedAt: string;
  endedAt: string;
  journal: Journal;
}): CaptureSegment {
  const segment: CaptureSegment = { kind: input.kind, startedAt: input.startedAt, endedAt: input.endedAt };
  if (input.journal.resources) segment.resources = input.journal.resources;
  if (input.journal.completeness !== "complete") {
    segment.partialReason = input.journal.partialReason ?? "capture reported incomplete attribution";
  }
  return segment;
}

/** A one-line, human-readable summary of a session's observation window and coverage. */
export function formatCoverage(coverage: SessionCoverage): string {
  return `${coverage.backend}: ${describeCompleteness(coverage)}; window ${formatWindow(coverage.segment)}; ${coverage.events} events over ${coverage.roots.length} roots`;
}

/** Formats a known observation window with its duration; absent ends remain explicitly unknown. */
export function formatWindow(segment: CaptureSegment): string {
  if (segment.endedAt === undefined) return `${segment.startedAt} → unknown`;
  const endedAt = segment.endedAt;
  const seconds = (Date.parse(endedAt) - Date.parse(segment.startedAt)) / 1000;
  return `${segment.startedAt} → ${endedAt} (${seconds.toFixed(1)}s)`;
}

function describeCompleteness(coverage: SessionCoverage): string {
  switch (coverage.completeness) {
    case "complete":
      return "process-tree coverage complete";
    case "partial":
      return `process-tree coverage partial${coverage.partialReason === undefined ? "" : `: ${coverage.partialReason}`}`;
    case "heuristic":
      return `heuristic attribution, no process tree${coverage.partialReason === undefined ? "" : `: ${coverage.partialReason}`}`;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
