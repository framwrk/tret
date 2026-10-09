import type { MutatedEntry, OwnedEntry, RecordFileV3, RecordV3, ToolRecord } from "../types";

// Records v3 and the explicit v2 -> v3 migration (plan section 7).
//
// The pre-rewrite v2 writers (`saveRecord`/`removeRecord`) are **disabled**: version 3 is the only
// format any code path may write, so a late legacy call can never drop a migrated file back to v2
// and mix record shapes (B3/S6). Every persisted record goes through `FileStorage`. The pure
// migration functions below are retained, because `FileStorage` reads v2 files through them.
//
// Migration is a pure transformation: it reads no files and writes nothing. Callers persist the
// result, so a malformed file throws instead of producing an empty one, and no entry is dropped or
// given restore capability the v2 record never had.

/** Raised when a retired pre-rewrite v2 writer is invoked; nothing may write v2 any more (B3). */
export class LegacyRecordWriteError extends Error {
  constructor(name: string) {
    super(`refusing to write the legacy v2 record for ${name}; tret persists version 3 records only`);
    this.name = "LegacyRecordWriteError";
  }
}

/**
 * Disabled pre-rewrite v2 writer. It is kept (rather than deleted) so any forgotten caller fails
 * loudly instead of silently downgrading a migrated records file; `FileStorage.saveRecord` is the
 * only supported write path.
 */
export function saveRecord(record: ToolRecord): never {
  throw new LegacyRecordWriteError(record.name);
}

/** Disabled pre-rewrite v2 writer; removal by name is now `FileStorage.removeRecord(id)` (B3). */
export function removeRecord(name: string): never {
  throw new LegacyRecordWriteError(name);
}

/** How a migrated v2 record should be interpreted where the v2 format stored no answer. */
export type LegacyMigrationOptions = {
  /**
   * Case sensitivity to assume for migrated records. v2 shipped on macOS only, whose default is
   * case-insensitive, so the default is `false`; callers that know the mount can override it (D10).
   */
  caseSensitive?: boolean;
};

/** Backend label stored on migrated records: evidence-free ownership from the v2 format. */
export const LEGACY_BACKEND = "legacy-v2";

/** Raised when a records file cannot be migrated without losing or inventing data. */
export class RecordMigrationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "RecordMigrationError";
    this.issues = issues;
  }
}

/**
 * Maps one v2 record to v3 without inventing provenance. Added paths become legacy ownership with
 * `kind: "unknown"` and no hash; edited paths become non-restorable mutations with no before/after
 * hashes and no before-image, so nothing migrated can be mistaken for restorable. `find` records
 * keep their source, URL, and script-hash semantics, and no path is lost.
 */
export function migrateRecordV2ToV3(record: ToolRecord, options: LegacyMigrationOptions = {}): RecordV3 {
  const owned: OwnedEntry[] = record.added.map((path) => ({ path, kind: "unknown" }));
  const mutated: MutatedEntry[] = record.edited.map((path) => ({ path }));

  return {
    id: legacyRecordId(record),
    name: record.name,
    source: record.source,
    url: record.url,
    installedAt: record.installedAt,
    executable: record.executable,
    scriptSha256: record.scriptSha256,
    capture: {
      backend: LEGACY_BACKEND,
      completeness: "heuristic",
      segments: [
        {
          kind: record.source === "find" ? "find" : "install",
          startedAt: record.installedAt,
          partialReason: "migrated from v2: no journal evidence",
        },
      ],
    },
    // v2 never ran an install as root, so "user" is a recorded fact rather than a guess (D8).
    privilege: "user",
    caseSensitive: options.caseSensitive ?? false,
    owned,
    mutated,
    deleted: [],
  };
}

/**
 * Migrates a parsed records file to v3. A v2 file is mapped record by record; an already-v3 file is
 * validated and returned unchanged so a retried migration is idempotent. Malformed input throws a
 * `RecordMigrationError` listing every problem, which is how a failed migration avoids silently
 * erasing the user's records.
 */
export function migrateRecordFileV2ToV3(value: unknown, options: LegacyMigrationOptions = {}): RecordFileV3 {
  if (!isObject(value)) {
    throw new RecordMigrationError("records file is not an object");
  }

  if (value.version === 3) {
    return validateRecordFileV3(value);
  }

  if (value.version !== 2) {
    throw new RecordMigrationError(`unsupported records version: ${String(value.version)}`);
  }

  if (!Array.isArray(value.records)) {
    throw new RecordMigrationError("records file has no records array");
  }

  const issues: string[] = [];
  const records: RecordV3[] = [];
  value.records.forEach((entry, index) => {
    try {
      records.push(migrateRecordV2ToV3(validateV2Record(entry, index), options));
    } catch (error) {
      if (error instanceof RecordMigrationError) {
        issues.push(...error.issues);
        return;
      }
      throw error;
    }
  });

  if (issues.length > 0) {
    throw new RecordMigrationError("records file has malformed records", issues);
  }

  return { version: 3, records };
}

/** A deterministic id for a migrated record, so migrating the same v2 file twice yields the same value. */
function legacyRecordId(record: ToolRecord): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update([record.name, record.source, record.url, record.installedAt, record.executable].join("\u0000"));
  return `v2-${hasher.digest("hex").slice(0, 16)}`;
}

/** Validates a v2 record and normalizes the pre-`source` default to an install; never fills other gaps. */
function validateV2Record(value: unknown, index: number): ToolRecord {
  const where = `records[${index}]`;
  if (!isObject(value)) {
    throw new RecordMigrationError(`record ${index} is not an object`, [where]);
  }

  const issues: string[] = [];
  const requireString = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string") {
      issues.push(`${where}.${field} must be a string`);
      return "";
    }
    return raw;
  };

  const name = requireString("name");
  if (name.length === 0) issues.push(`${where}.name must not be empty`);
  const url = requireString("url");
  const installedAt = requireString("installedAt");
  const executable = requireString("executable");
  const scriptSha256 = requireString("scriptSha256");

  // Records saved before `source` existed were all installs.
  let source: "install" | "find" = "install";
  const rawSource = value.source;
  if (rawSource !== undefined) {
    if (rawSource === "install" || rawSource === "find") source = rawSource;
    else issues.push(`${where}.source must be "install" or "find"`);
  }

  const added = requireStringArray(value.added, `${where}.added`, issues);
  const edited = requireStringArray(value.edited, `${where}.edited`, issues);

  if (issues.length > 0) {
    throw new RecordMigrationError(`record ${index} is malformed`, issues);
  }

  return { name, source, url, installedAt, executable, scriptSha256, added, edited };
}

function requireStringArray(value: unknown, where: string, issues: string[]): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    issues.push(`${where} must be an array of strings`);
    return [];
  }
  return value as string[];
}

/** Shallow structural validation of a v3 file, enough to reject a corrupt one before trusting it. */
function validateRecordFileV3(value: Record<string, unknown>): RecordFileV3 {
  if (value.version !== 3) {
    throw new RecordMigrationError(`unsupported records version: ${String(value.version)}`);
  }
  if (!Array.isArray(value.records)) {
    throw new RecordMigrationError("records file has no records array");
  }

  const issues: string[] = [];
  value.records.forEach((entry, index) => {
    if (!isV3Record(entry)) issues.push(`records[${index}] is not a valid v3 record`);
  });

  if (issues.length > 0) {
    throw new RecordMigrationError("records file has malformed records", issues);
  }

  return { version: 3, records: value.records as RecordV3[] };
}

/** Structural validation of one v3 record, enough to reject a corrupt or foreign entry before trusting it. */
export function isV3Record(value: unknown): value is RecordV3 {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.source !== "install" && value.source !== "find") ||
    typeof value.url !== "string" ||
    typeof value.installedAt !== "string" ||
    typeof value.executable !== "string" ||
    typeof value.scriptSha256 !== "string" ||
    (value.privilege !== "user" && value.privilege !== "root") ||
    typeof value.caseSensitive !== "boolean" ||
    !Array.isArray(value.owned) ||
    !Array.isArray(value.mutated) ||
    !Array.isArray(value.deleted)
  ) {
    return false;
  }

  if (value.managedBy !== undefined && !isManagedPackage(value.managedBy)) return false;

  const capture = value.capture;
  if (!isObject(capture)) return false;
  if (typeof capture.backend !== "string") return false;
  if (capture.completeness !== "complete" && capture.completeness !== "partial" && capture.completeness !== "heuristic") {
    return false;
  }
  return Array.isArray(capture.segments);
}

/** Validates the optional `managedBy` field: a known manager plus a non-empty package spec. */
function isManagedPackage(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.package !== "string" || value.package.length === 0) return false;
  return value.manager === "bun" || value.manager === "npm" || value.manager === "pnpm" || value.manager === "yarn";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
