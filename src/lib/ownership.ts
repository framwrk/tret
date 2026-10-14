import type { CaptureCompleteness, OwnershipConfidence } from "../types";

// Ownership confidence (D11).
//
// A record's `capture.completeness` already says how much of the installer's process tree a backend
// could prove. This module turns that into the one label a user needs when Tret proposes a
// destructive action: whether each path is *proven* to have come from the installer's observed tree,
// or only *observed* to differ across a bounded window, where unrelated activity looks the same as
// installer output. Nothing here changes what Tret is allowed to remove; verification decides that
// and treats both labels identically. The label only keeps the evidence honest in the output.
//
// Deriving it instead of storing it keeps one source of truth: a record whose completeness is edited
// cannot keep claiming a confidence its evidence no longer supports. A `partial` window is `observed`
// because attribution was lost somewhere in the tree, even though the paths it did see were watched.

/** The confidence a capture's completeness label supports. Only a `complete` window proves ownership. */
export function ownershipConfidence(completeness: CaptureCompleteness): OwnershipConfidence {
  return completeness === "complete" ? "proven" : "observed";
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
  return "note: these paths were only observed during a bounded window, not proven to come from the installer";
}
