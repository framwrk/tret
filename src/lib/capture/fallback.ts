import type { AbsolutePath } from "../../types";
import type { BoundedSessionOptions, BoundedSessionResult } from "../session";
import type { CaptureBackend } from "./backend";
import { runBoundedSession } from "../session";

/**
 * One pre-run capture attempt: either a completed session (possibly from the fallback backend), or a
 * refusal after both backends failed to attach. `run` never executes when the refusal is returned.
 */
export type CaptureFallbackResult<T> =
  | {
      session: BoundedSessionResult<T>;
      usedFallback: boolean;
      /** The primary backend's attach failure, when the fallback was used. */
      primaryError?: unknown;
    }
  | {
      session: undefined;
      usedFallback: false;
      primaryError: unknown;
      fallbackError: unknown;
    };

export type CaptureFallbackOptions<T> = Omit<BoundedSessionOptions<T>, "backend" | "roots"> & {
  /** The platform's first-choice backend. */
  primary: CaptureBackend;
  /** The labeled heuristic backend to try only when the primary cannot attach. */
  fallback: CaptureBackend;
  /** Roots for the primary window. */
  roots: AbsolutePath[];
  /** Roots for the fallback window; defaults to the primary roots. */
  fallbackRoots?: AbsolutePath[];
  /** Reports the primary attach failure before the fallback starts. */
  onPrimaryFailure?: (error: unknown) => void;
  /** Reports the fallback attach failure before the refusal is returned. */
  onFallbackFailure?: (error: unknown) => void;
};

/**
 * Runs one bounded capture session with a pre-run fallback. The observed work runs at most once:
 * `runBoundedSession` starts the backend before calling it, so a backend that throws from `start`
 * has not observed anything and a different backend may still take the window. Once a backend has
 * started, every later failure is reported by the session as partial or as the work's own error; it
 * never returns here as an attach failure, so the tool is never re-run for it. If both backends
 * fail to attach, the result carries both errors and `run` was not called.
 */
export async function runCaptureFallback<T>(options: CaptureFallbackOptions<T>): Promise<CaptureFallbackResult<T>> {
  const {
    primary,
    fallback,
    roots,
    fallbackRoots,
    onPrimaryFailure,
    onFallbackFailure,
    ...sessionOptions
  } = options;

  try {
    return {
      session: await runBoundedSession({ ...sessionOptions, backend: primary, roots }),
      usedFallback: false,
    };
  } catch (primaryError) {
    onPrimaryFailure?.(primaryError);
    try {
      return {
        session: await runBoundedSession({
          ...sessionOptions,
          backend: fallback,
          roots: fallbackRoots ?? roots,
        }),
        usedFallback: true,
        primaryError,
      };
    } catch (fallbackError) {
      onFallbackFailure?.(fallbackError);
      return { session: undefined, usedFallback: false, primaryError, fallbackError };
    }
  }
}

/**
 * Roots for the heuristic fallback: the install scope minus the unbounded system trees `/opt` and
 * `/usr/bin`. The scoped-snapshot engine scans a non-home root whole and, with `--backup`, reads
 * every pre-existing file to keep its bytes; those two trees are shared multi-GB surfaces (a
 * runner's tool cache and system binaries), so keeping them would replay the very stall the
 * baseline walk now prunes. `$HOME` is already part of the install scope on every platform
 * (`captureHomeRoot`), so it is not re-added here: an explicit `--observe-exclude $HOME` must narrow
 * the fallback the same way it narrows a real capture. The narrower `/usr/local/bin` install surface
 * stays.
 */
export function heuristicFallbackRoots(roots: AbsolutePath[]): AbsolutePath[] {
  const scoped = new Set(roots);
  scoped.delete("/opt");
  scoped.delete("/usr/bin");
  return [...scoped].sort();
}
