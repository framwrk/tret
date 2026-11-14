import type { EffectEvidence, RecordFileV4, RecordV3, RecordV4 } from "../types";
import { RecordMigrationError, isV3Record, migrateRecordFileV2ToV3 } from "./records";
import { validCleanupApproval } from "./cleanup-authority";

/** The digest binds evidence to an exact candidate, not just to a mutable path or tool name. */
export function candidateEffects(record: RecordV3): Array<{
  id: string;
  path: string;
  section: EffectEvidence["section"];
  beforeImage: EffectEvidence["beforeImage"];
}> {
  const candidates = [];
  for (const section of ["owned", "mutated", "deleted"] as const) {
    for (const entry of record[section]) {
      const beforeBlob = "beforeBlob" in entry ? entry.beforeBlob : undefined;
      const digest = new Bun.CryptoHasher("sha256")
        .update(
          JSON.stringify([
            record.id,
            section,
            entry.path,
            "kind" in entry ? entry.kind : null,
            "linkTarget" in entry ? (entry.linkTarget ?? null) : null,
            "installedHash" in entry ? (entry.installedHash ?? null) : null,
            "beforeHash" in entry ? (entry.beforeHash ?? null) : null,
            beforeBlob ?? null,
            "mode" in entry ? (entry.mode ?? null) : null,
          ]),
        )
        .digest("hex");
      candidates.push({
        id: digest,
        path: entry.path,
        section,
        beforeImage: beforeBlob === undefined ? ("unavailable" as const) : ("referenced" as const),
      });
    }
  }
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

/** No legacy optional field can import authority or a fabricated revision into the new format. */
export function observedRecord(
  record: RecordV3,
  revision: number,
  origin: EffectEvidence["origin"],
  preserveDecisions = false,
): RecordV4 {
  const previous = new Map(preserveDecisions ? record.evidence?.map((entry) => [entry.id, entry]) : []);
  return {
    ...record,
    revision,
    evidence: candidateEffects(record).map(
      (candidate) =>
        previous.get(candidate.id) ?? {
          ...candidate,
          origin,
          attribution: origin === "legacy-v2" || origin === "legacy-v3" ? "unknown" : "observed",
          authority: "none",
        },
    ),
  };
}

/** Pure read normalization. Only the writer may retain originals and commit a migration. */
export function readRecordFile(value: unknown): RecordFileV4 {
  if (object(value) && value.version === 4) return validateRecordFileV4(value);
  const legacy = migrateRecordFileV2ToV3(value);
  const origin = object(value) && value.version === 2 ? "legacy-v2" : "legacy-v3";
  return { version: 4, sequence: 0, records: legacy.records.map((record) => observedRecord(record, 0, origin)) };
}

export function validateRecordFileV4(value: unknown): RecordFileV4 {
  const issues: string[] = [];
  if (!object(value) || value.version !== 4) throw new RecordMigrationError("records file is not version 4");
  if (!revision(value.sequence)) issues.push("sequence must be a nonnegative safe integer");
  if (!Array.isArray(value.records)) throw new RecordMigrationError("records file has no records array");
  const ids = new Set<string>();
  const positiveRevisions = new Set<number>();
  value.records.forEach((raw, index) => {
    const where = `records[${index}]`;
    if (!isV3Record(raw)) {
      issues.push(`${where} is not valid record evidence`);
      return;
    }
    if (ids.has(raw.id)) issues.push(`${where}.id is duplicated`);
    ids.add(raw.id);
    if (!revision(raw.revision) || !revision(value.sequence) || raw.revision > value.sequence) {
      issues.push(`${where}.revision exceeds sequence or is invalid`);
    } else if (raw.revision > 0) {
      if (positiveRevisions.has(raw.revision)) issues.push(`${where}.revision is duplicated`);
      positiveRevisions.add(raw.revision);
    }
    const evidence: unknown = (raw as RecordV3 & { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) {
      issues.push(`${where}.evidence must enumerate every candidate`);
      return;
    }
    const expected = new Map(candidateEffects(raw).map((candidate) => [candidate.id, candidate]));
    const seen = new Set<string>();
    evidence.forEach((entry, evidenceIndex) => {
      const field = `${where}.evidence[${evidenceIndex}]`;
      if (!object(entry) || typeof entry.id !== "string") {
        issues.push(`${field} is invalid`);
        return;
      }
      const candidate = expected.get(entry.id);
      if (
        !candidate ||
        seen.has(entry.id) ||
        candidate.path !== entry.path ||
        candidate.section !== entry.section ||
        candidate.beforeImage !== entry.beforeImage
      ) {
        issues.push(`${field} does not match a unique candidate`);
      }
      seen.add(entry.id);
      if (!["legacy-v2", "legacy-v3", "capture", "trace", "find", "adoption"].includes(String(entry.origin)))
        issues.push(`${field}.origin is invalid`);
      if (entry.attribution !== "unknown" && entry.attribution !== "observed") issues.push(`${field}.attribution is invalid`);
      // Future authorization kinds require an explicit validator and application implementation.
      if (
        entry.authority !== "none" &&
        (entry.authority !== "user-approved" || !validCleanupApproval(entry.approval, candidate?.path ?? ""))
      )
        issues.push(`${field}.authority is unsupported or malformed`);
    });
    if (seen.size !== expected.size) issues.push(`${where}.evidence omits candidates`);
  });
  if (issues.length) throw new RecordMigrationError("version 4 records file has malformed records", issues);
  return value as RecordFileV4;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
