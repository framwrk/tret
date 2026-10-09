import type { AbsolutePath, CaptureCompleteness, CaptureSegment, Privilege } from "../types";
import type { CaptureBackend } from "./capture/backend";
import type { Journal } from "./capture/events";

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
  /** The journal the backend produced; a stop failure becomes an empty `partial` journal. */
  journal: Journal;
  coverage: SessionCoverage;
};

export type BoundedSessionOptions<T> = {
  /** The capture mechanism to attach for the window. */
  backend: CaptureBackend;
  /**
   * Process id whose descendants the backend observes. A caller that runs the work as a child passes
   * its own pid, so capture can start before the child exists and the child is still inside the tree.
   */
  pid: number;
  /** Privilege the observed work runs under, for sudo-aware coverage (D8). */
  privilege: Privilege;
  /** Absolute roots to observe, already expanded from the active platform table. */
  roots: AbsolutePath[];
  /** The bounded work to run while capture is attached. */
  run: () => Promise<T>;
  /** Clock in milliseconds; injectable so tests can pin the window. */
  now?: () => number;
  /** Which kind of window this is; defaults to "install" (`trace` is reserved by D5 for later). */
  kind?: CaptureSegment["kind"];
};

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

  const session = await options.backend.start({
    pid: options.pid,
    privilege: options.privilege,
    roots: options.roots,
  });

  let value: T | undefined;
  let error: unknown;
  try {
    value = await options.run();
  } catch (caught) {
    error = caught;
  }

  let journal: Journal;
  try {
    journal = await session.stop();
  } catch (caught) {
    // Closing is part of the window. A backend that fails to close leaves attribution partial, not
    // green: report the blind spot and keep whatever the work produced.
    journal = {
      backend: session.backend,
      completeness: "partial",
      partialReason: `capture failed to close: ${message(caught)}`,
      events: [],
    };
  }

  const endedAt = new Date(clock()).toISOString();
  return {
    value,
    error,
    journal,
    coverage: {
      backend: journal.backend,
      completeness: journal.completeness,
      ...(journal.partialReason === undefined ? {} : { partialReason: journal.partialReason }),
      segment: buildCaptureSegment({ kind: options.kind ?? "install", startedAt, endedAt, journal }),
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
  if (input.journal.completeness !== "complete") {
    segment.partialReason = input.journal.partialReason ?? "capture reported incomplete attribution";
  }
  return segment;
}

/** A one-line, human-readable summary of a session's observation window and coverage. */
export function formatCoverage(coverage: SessionCoverage): string {
  return `${coverage.backend}: ${describeCompleteness(coverage)}; window ${formatWindow(coverage.segment)}; ${coverage.events} events over ${coverage.roots.length} roots`;
}

/** Formats a segment's observation window as `start → end (Ns)`. */
export function formatWindow(segment: CaptureSegment): string {
  const endedAt = segment.endedAt ?? segment.startedAt;
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
