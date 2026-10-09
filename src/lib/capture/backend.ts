import type { AbsolutePath, CaptureCompleteness, Privilege } from "../../types";
import type { BackupPolicy } from "./normalize";
import type { Journal } from "./events";

/** Inputs for one bounded capture window. */
export type CaptureStartOptions = {
  /** Process id of the installer; its descendants are the attribution target. */
  pid: number;
  /** Privilege the install runs under, for sudo-aware handling (D8). */
  privilege: Privilege;
  /** Absolute roots to observe, already expanded from the active Platform table. */
  roots: AbsolutePath[];
  /**
   * Before-image backup policy (D2). Off by default, so a backend captures no file content unless
   * the caller opts in; when on, a backend captures pre-existing bytes within the size limit.
   */
  backups?: BackupPolicy;
};

/** An active observation window; `stop` closes it and returns the collected journal. */
export type CaptureSession = {
  readonly backend: string;
  stop(): Promise<Journal>;
};

/**
 * A replaceable mechanism that turns an install's filesystem activity into a journal. Record
 * processing and uninstall depend on this interface, never on a particular OS mechanism, so a
 * Linux tracer and the labeled macOS heuristic fallback produce the same shape.
 */
export interface CaptureBackend {
  /** Identifier stored in `record.capture.backend` (for example "linux-fanotify"). */
  readonly name: string;
  /** Coverage the backend can prove; advisory until a session reports its own journal. */
  readonly completeness: CaptureCompleteness;
  /** Begins observing the process tree for the bounded install window. */
  start(options: CaptureStartOptions): Promise<CaptureSession>;
}
