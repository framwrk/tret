// Predictable record selection (plan 03 item 4).
//
// A tool name is not a stable identity: an install can be given a display name, and two installs
// can end up with the same command name. Every command that acts on one record (uninstall, forget,
// inspect, trace, update) resolves its argument here, so they all agree on what a selector means:
// an exact record id wins, then an exact display name; several name matches are an error that lists
// the candidates by id instead of silently picking the first one.

import type { RecordV3 } from "../types";

/** The outcome of resolving a selector against the stored records. */
export type RecordSelection =
  | { ok: true; record: RecordV3 }
  | {
      ok: false;
      reason: "not-found" | "ambiguous";
      message: string;
      /** The same-named records when `reason` is "ambiguous"; empty otherwise. */
      candidates: RecordV3[];
    };

/**
 * Resolves `selector` to exactly one record. A selector equal to a record's id is unambiguous even
 * when several records share a name; a selector equal to a name resolves only when one record has
 * that name. Candidates are ordered deterministically (oldest install first, then id) so repeated
 * runs report the same list.
 */
export function selectRecord(records: readonly RecordV3[], selector: string | undefined): RecordSelection {
  const wanted = selector?.trim() ?? "";
  if (wanted.length === 0) {
    return { ok: false, reason: "not-found", message: "a tool name or record id is required", candidates: [] };
  }

  const byId = records.find((record) => record.id === wanted);
  if (byId) return { ok: true, record: byId };

  const named = records.filter((record) => record.name === wanted);
  if (named.length === 1) return { ok: true, record: named[0]! };
  if (named.length === 0) {
    return { ok: false, reason: "not-found", message: `no tracked install matches ${wanted}`, candidates: [] };
  }

  return {
    ok: false,
    reason: "ambiguous",
    message: `${named.length} tracked installs are named ${wanted}; select one by record id`,
    candidates: sortCandidates(named),
  };
}

/** The human lines listing same-named candidates: one per record, id first so it can be copied. */
export function formatSelectionCandidates(selection: Extract<RecordSelection, { ok: false }>): string[] {
  return selection.candidates.map((record) => {
    const installed = record.installedAt.slice(0, 10);
    const executable = record.executable === "" ? "no tracked binary" : record.executable;
    return `${record.id}  ${record.name}  installed ${installed}  ${executable}`;
  });
}

function sortCandidates(records: RecordV3[]): RecordV3[] {
  return records
    .slice()
    .sort((a, b) => a.installedAt.localeCompare(b.installedAt) || a.id.localeCompare(b.id));
}
