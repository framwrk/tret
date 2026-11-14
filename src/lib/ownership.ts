import type { CaptureCompleteness, OwnershipConfidence } from "../types";

// Window completeness is coverage evidence, never object ownership or disposal authority.
// The historical `proven` display value is retained for compatibility with injected reports;
// current captures report observations, while per-effect approval is checked by the planner.

/** No record-wide coverage label proves that a particular current object is disposable. */
export function ownershipConfidence(completeness: CaptureCompleteness): OwnershipConfidence {
  // A window-wide label supplies no per-object causality or disposal authority.
  void completeness;
  return "observed";
}

/**
 * The suffix one destructive plan line carries when its path is only observed; empty when the
 * installer is proven to have made it. Always paired with `ownershipNote`, which explains it once.
 */
export function ownershipMarker(confidence: OwnershipConfidence): string {
  return confidence === "observed" ? " (observed, not proven)" : "";
}

/**
 * The one-line caveat a command prints once before proposing or taking destructive actions on an
 * observed record, or `undefined` when the capture proved ownership. It states the limit plainly
 * without promising a second removal rule: verification decides what may change, for both labels.
 */
export function ownershipNote(confidence: OwnershipConfidence): string | undefined {
  if (confidence === "proven") return undefined;
  return "note: these paths are observed, not proven to belong to this tool";
}
