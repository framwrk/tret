import type { AbsolutePath, DeletedEntry, MutatedEntry, OwnedEntry } from "../../types";
import type { BlobId } from "../storage";
import type { Journal } from "./events";

/**
 * The install effects a journal normalizes into (plan section 3). The types are frozen here so
 * later phases, storage, and the uninstall planner can be written against them; the pure conversion
 * is implemented in `src/lib/journal/normalize.ts` and re-exported at the bottom of this file.
 */
export type NormalizedEffects = {
  owned: OwnedEntry[];
  mutated: MutatedEntry[];
  deleted: DeletedEntry[];
  /** Relationships the record does not represent directly (temp-file collapses, renames, coverage). */
  diagnostics: NormalizationDiagnostic[];
};

/** Kinds of diagnostic normalization emits when it edits the raw event sequence. */
export type NormalizationDiagnosticCode = "temp-rename" | "create-delete" | "rename" | "coverage" | "unsupported";

export type NormalizationDiagnostic = {
  code: NormalizationDiagnosticCode;
  message: string;
  paths: AbsolutePath[];
};

/** Before-image backup policy fed to normalization (D2): off by default, bounded when on. */
export type BackupPolicy = {
  enabled: boolean;
  /** Files larger than this are recorded as mutations but not claimed restorable. */
  sizeLimitBytes: number;
};

/** Inputs the phase 3 converter accepts; frozen in phase 2 so callers can be written against it. */
export type NormalizeInput = {
  journal: Journal;
  backups: BackupPolicy;
  /** Whether the record's filesystem is case-sensitive (D10). */
  caseSensitive: boolean;
  /**
   * Content addresses for which before-image bytes were actually captured (D2). A mutation or
   * deletion is claimed restorable only when its before hash appears here, so normalization never
   * invents a before-image that storage does not hold. Defaults to none.
   */
  availableBeforeImages?: ReadonlySet<BlobId>;
};

// Phase 3 implements the conversion in the `journal` module; re-exported here so the frozen
// contract path keeps exposing normalization to capture, storage, and uninstall.
export { normalizeJournal } from "../journal/normalize";
