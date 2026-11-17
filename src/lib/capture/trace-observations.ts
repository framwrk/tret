import type { OwnedKind, RecordV3 } from "../../types";
import { claimedByOthers, sharedClaim } from "../uninstall-planner";
import type { NormalizedEffects } from "./normalize";

/** Window facts for inspection only. These never supply cleanup candidates or blob references. */
export type TraceObservation = {
  effect: "created" | "modified" | "deleted";
  path: string;
  disposition: "new-candidate" | "already-tracked" | "claimed-by-other";
  kind?: OwnedKind;
  installedHash?: string;
  linkTarget?: string;
  beforeHash?: string;
  mode?: number;
};
export type TraceObservations = { entries: TraceObservation[]; omitted: number };
const MAX_ENTRIES = 32;
const MAX_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const KEYS = ["effect", "path", "disposition", "kind", "installedHash", "linkTarget", "beforeHash", "mode"];
function validEntry(value: unknown): value is TraceObservation {
  if (!value || typeof value !== "object") return false;
  const entry = value as TraceObservation;
  if (
    !Object.keys(value).every((key) => KEYS.includes(key)) ||
    typeof entry.path !== "string" ||
    !entry.path.startsWith("/") ||
    entry.path.includes("\0") ||
    Buffer.byteLength(entry.path) > 4096 ||
    !["new-candidate", "already-tracked", "claimed-by-other"].includes(entry.disposition)
  )
    return false;
  if (
    [entry.beforeHash, entry.installedHash].some((hash) => hash !== undefined && (typeof hash !== "string" || !HASH.test(hash)))
  )
    return false;
  if (entry.mode !== undefined && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777)) return false;
  if (entry.effect === "created")
    return (
      ["file", "directory", "symlink", "unknown"].includes(String(entry.kind)) &&
      entry.beforeHash === undefined &&
      entry.mode === undefined &&
      (entry.linkTarget === undefined ||
        (entry.kind === "symlink" &&
          typeof entry.linkTarget === "string" &&
          !entry.linkTarget.includes("\0") &&
          Buffer.byteLength(entry.linkTarget) <= 4096))
    );
  return (
    (entry.effect === "modified" || entry.effect === "deleted") &&
    entry.kind === undefined &&
    entry.linkTarget === undefined &&
    (entry.effect !== "deleted" || entry.installedHash === undefined)
  );
}
export function validTraceObservations(value: unknown): value is TraceObservations {
  if (!value || typeof value !== "object") return false;
  const report = value as TraceObservations;
  return (
    Object.keys(value).every((key) => key === "entries" || key === "omitted") &&
    Array.isArray(report.entries) &&
    report.entries.length <= MAX_ENTRIES &&
    report.entries.every(validEntry) &&
    Number.isSafeInteger(report.omitted) &&
    report.omitted >= 0 &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES
  );
}

/** Preserve trace-window facts separately from the install's earliest evidence and decisions. */
export function traceObservations(record: RecordV3, effects: NormalizedEffects, records: RecordV3[]): TraceObservations {
  const tracked = new Set([...record.owned, ...record.mutated, ...record.deleted].map((entry) => entry.path));
  const claims = claimedByOthers(records, record.id);
  const entries: TraceObservation[] = [];
  let omitted = 0;
  const push = (change: Omit<TraceObservation, "disposition">) => {
    const disposition = tracked.has(change.path)
      ? "already-tracked"
      : sharedClaim(claims, change.path, record.caseSensitive)
        ? "claimed-by-other"
        : "new-candidate";
    if (disposition === "new-candidate") tracked.add(change.path);
    const entry = { ...change, disposition } as TraceObservation;
    if (
      entries.length >= MAX_ENTRIES ||
      !validEntry(entry) ||
      Buffer.byteLength(JSON.stringify({ entries: [...entries, entry], omitted: Number.MAX_SAFE_INTEGER })) > MAX_BYTES
    )
      omitted++;
    else entries.push(entry);
  };
  for (const entry of effects.owned)
    push({
      effect: "created",
      path: entry.path,
      kind: entry.kind,
      ...(entry.installedHash !== undefined ? { installedHash: entry.installedHash } : {}),
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
    });
  for (const entry of effects.mutated)
    push({
      effect: "modified",
      path: entry.path,
      ...(entry.beforeHash !== undefined ? { beforeHash: entry.beforeHash } : {}),
      ...(entry.installedHash !== undefined ? { installedHash: entry.installedHash } : {}),
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    });
  for (const entry of effects.deleted)
    push({
      effect: "deleted",
      path: entry.path,
      ...(entry.beforeHash !== undefined ? { beforeHash: entry.beforeHash } : {}),
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    });
  return { entries, omitted };
}

export function formatTraceObservations(report?: TraceObservations): string[] {
  const lines = (report?.entries ?? []).map((entry) => {
    const facts = [
      entry.disposition,
      ...(entry.beforeHash ? [`window-before ${entry.beforeHash}`] : []),
      ...(entry.installedHash ? [`window-after ${entry.installedHash}`] : []),
      ...(entry.linkTarget !== undefined ? [`link ${entry.linkTarget}`] : []),
      ...(entry.mode !== undefined ? [`window-before mode ${entry.mode.toString(8)}`] : []),
    ];
    return `observed ${entry.effect} ${entry.path} (${facts.join("; ")})`;
  });
  if (report?.omitted) lines.push(`${report.omitted} trace observations omitted by reporting limits`);
  return lines;
}
