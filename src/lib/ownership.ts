import type { CaptureCompleteness, OwnershipConfidence } from "../types";

// Ownership confidence (D11).
//
// A record's `capture.completeness` says how much evidence a capture provides. This module turns it
// into the one label a user needs when Tret proposes a destructive action: whether the capture
// attributes a path to the installer's process tree, or whether the path is only observed and not
// proven to belong to the tool. The latter also covers `find` records, which have no install window
// or journal. Nothing here changes what Tret is allowed to remove; verification decides that and
// treats both labels identically. The label only keeps the evidence honest in the output.
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
  return "note: these paths are observed, not proven to belong to this tool";
}
