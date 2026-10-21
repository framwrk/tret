import type { MutatedEntry, OwnedEntry, RecordFileV3, RecordV3, ToolRecord } from "../types";

// Records v3 and the explicit v2 -> v3 migration (plan section 7).
//
// The pre-rewrite v2 writers (`saveRecord`/`removeRecord`) are **disabled**: version 3 is the only
// format any code path may write, so a late legacy call can never drop a migrated file back to v2
// and mix record shapes. Every persisted record goes through `FileStorage`. The pure
// migration functions below are retained, because `FileStorage` reads v2 files through them.
//
// Migration is a pure transformation: it reads no files and writes nothing. Callers persist the
// result, so a malformed file throws instead of producing an empty one, and no entry is dropped or
// given restore capability the v2 record never had.

/** Raised when a retired pre-rewrite v2 writer is invoked; nothing may write v2 any more. */
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

/** Disabled pre-rewrite v2 writer; removal by name is now `FileStorage.removeRecord(id)`. */
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

  // The migrated output must satisfy the same deep validation a v3 file is held to, so migration
  // can never write a file the next load refuses to read. v2 stored bare path strings, so a
  // relative one fails here instead of becoming a record uninstall might resolve against its own
  // working directory.
  const migratedIssues: string[] = [];
  records.forEach((record, index) => {
    for (const reason of recordV3Issues(record)) migratedIssues.push(`records[${index}].${reason}`);
  });

  if (migratedIssues.length > 0) {
    throw new RecordMigrationError("records file has records that cannot migrate to valid v3", migratedIssues);
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

/** Deep structural validation of a v3 file, enough to reject a corrupt one before trusting it. */
function validateRecordFileV3(value: Record<string, unknown>): RecordFileV3 {
  if (value.version !== 3) {
    throw new RecordMigrationError(`unsupported records version: ${String(value.version)}`);
  }
  if (!Array.isArray(value.records)) {
    throw new RecordMigrationError("records file has no records array");
  }

  const issues: string[] = [];
  value.records.forEach((entry, index) => {
    if (!isObject(entry)) {
      issues.push(`records[${index}] is not an object`);
      return;
    }
    for (const reason of recordV3Issues(entry)) issues.push(`records[${index}].${reason}`);
  });

  if (issues.length > 0) {
    throw new RecordMigrationError("records file has malformed records", issues);
  }

  return { version: 3, records: value.records as RecordV3[] };
}

/**
 * Deep validation of one v3 record: nested entries, capture segments, fingerprints, before-image
 * references, and absolute paths are all checked, because later code trusts them without
 * re-checking. A relative or non-string entry path would be resolved against the caller's working
 * directory by uninstall, a non-sha256 fingerprint would silently make verification incomparable,
 * and a `beforeBlob` that is not a content address could never name a stored blob. A record that
 * fails any check is rejected whole; nothing is dropped, guessed, or repaired in place.
 */
export function isV3Record(value: unknown): value is RecordV3 {
  return isObject(value) && recordV3Issues(value).length === 0;
}

/** Collects one reason per problem in a v3 record, so a rejection names the field at fault. */
function recordV3Issues(value: Record<string, unknown>): string[] {
  const issues: string[] = [];

  requireNonEmptyString(value.id, "id", issues);
  requireNonEmptyString(value.name, "name", issues);
  if (value.source !== "install" && value.source !== "find") issues.push(`source must be "install" or "find"`);
  requireString(value.url, "url", issues); // A `find` record has no URL.
  requireNonEmptyString(value.installedAt, "installedAt", issues);
  requireString(value.executable, "executable", issues); // Empty is the partial record with no executable.
  requireString(value.scriptSha256, "scriptSha256", issues); // Empty for `find` and migrated v2 records.
  if (value.scriptArgs !== undefined) {
    if (!Array.isArray(value.scriptArgs) || !value.scriptArgs.every((entry) => typeof entry === "string")) {
      issues.push("scriptArgs must be an array of strings when present");
    }
  }
  if (value.privilege !== "user" && value.privilege !== "root") issues.push(`privilege must be "user" or "root"`);
  if (typeof value.caseSensitive !== "boolean") issues.push("caseSensitive must be a boolean");
  if (value.managedBy !== undefined) managedPackageIssues(value.managedBy, "managedBy", issues);
  if (value.managedInstall !== undefined) managedInstallIssues(value.managedInstall, "managedInstall", issues);

  captureIssues(value.capture, issues);
  ownedIssues(value.owned, issues);
  mutatedIssues(value.mutated, issues);
  deletedIssues(value.deleted, issues);

  return issues;
}

/** Validates `capture`: a backend, a completeness label, and at least one well-formed segment. */
function captureIssues(value: unknown, issues: string[]): void {
  if (!isObject(value)) {
    issues.push("capture must be an object");
    return;
  }
  requireNonEmptyString(value.backend, "capture.backend", issues);
  if (value.completeness !== "complete" && value.completeness !== "partial" && value.completeness !== "heuristic") {
    issues.push(`capture.completeness must be "complete", "partial", or "heuristic"`);
  }
  if (!Array.isArray(value.segments) || value.segments.length === 0) {
    issues.push("capture.segments must be a non-empty array");
    return;
  }
  value.segments.forEach((segment, index) => {
    const where = `capture.segments[${index}]`;
    if (!isObject(segment)) {
      issues.push(`${where} must be an object`);
      return;
    }
    if (segment.kind !== "install" && segment.kind !== "trace" && segment.kind !== "find") {
      issues.push(`${where}.kind must be "install", "trace", or "find"`);
    }
    requireNonEmptyString(segment.startedAt, `${where}.startedAt`, issues);
    if (segment.endedAt !== undefined) requireNonEmptyString(segment.endedAt, `${where}.endedAt`, issues);
    if (segment.partialReason !== undefined) {
      requireNonEmptyString(segment.partialReason, `${where}.partialReason`, issues);
    }
  });
}

/** Validates every owned entry: an absolute path, a known kind, a symlink target only on symlinks, a sha256. */
function ownedIssues(value: unknown, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push("owned must be an array");
    return;
  }
  value.forEach((entry, index) => {
    const where = `owned[${index}]`;
    if (!isObject(entry)) {
      issues.push(`${where} must be an object`);
      return;
    }
    requireAbsolutePath(entry.path, `${where}.path`, issues);
    if (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink" && entry.kind !== "unknown") {
      issues.push(`${where}.kind must be "file", "directory", "symlink", or "unknown"`);
    }
    if (entry.linkTarget !== undefined) {
      requireNonEmptyString(entry.linkTarget, `${where}.linkTarget`, issues);
      if (entry.kind !== "symlink") issues.push(`${where}.linkTarget is only valid on a symlink entry`);
    }
    if (entry.installedHash !== undefined) requireSha256(entry.installedHash, `${where}.installedHash`, issues);
  });
}

/** Validates every mutation entry: an absolute path, sha256 fingerprints, and a real before-image address. */
function mutatedIssues(value: unknown, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push("mutated must be an array");
    return;
  }
  value.forEach((entry, index) => {
    const where = `mutated[${index}]`;
    if (!isObject(entry)) {
      issues.push(`${where} must be an object`);
      return;
    }
    requireAbsolutePath(entry.path, `${where}.path`, issues);
    if (entry.beforeHash !== undefined) requireSha256(entry.beforeHash, `${where}.beforeHash`, issues);
    if (entry.installedHash !== undefined) requireSha256(entry.installedHash, `${where}.installedHash`, issues);
    if (entry.beforeBlob !== undefined) requireSha256(entry.beforeBlob, `${where}.beforeBlob`, issues);
    if (entry.mode !== undefined) requireMode(entry.mode, `${where}.mode`, issues);
  });
}

/** Validates every deletion entry: an absolute path, a sha256 fingerprint, and a real before-image address. */
function deletedIssues(value: unknown, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push("deleted must be an array");
    return;
  }
  value.forEach((entry, index) => {
    const where = `deleted[${index}]`;
    if (!isObject(entry)) {
      issues.push(`${where} must be an object`);
      return;
    }
    requireAbsolutePath(entry.path, `${where}.path`, issues);
    if (entry.beforeHash !== undefined) requireSha256(entry.beforeHash, `${where}.beforeHash`, issues);
    if (entry.beforeBlob !== undefined) requireSha256(entry.beforeBlob, `${where}.beforeBlob`, issues);
    if (entry.mode !== undefined) requireMode(entry.mode, `${where}.mode`, issues);
  });
}

/** Validates the optional `managedBy` field: a known manager, a package spec, and an absolute shared root. */
function managedPackageIssues(value: unknown, where: string, issues: string[]): void {
  if (!isObject(value)) {
    issues.push(`${where} must be an object`);
    return;
  }
  if (value.manager !== "bun" && value.manager !== "npm" && value.manager !== "pnpm" && value.manager !== "yarn") {
    issues.push(`${where}.manager must be "bun", "npm", "pnpm", or "yarn"`);
  }
  requireNonEmptyString(value.package, `${where}.package`, issues);
  if (value.globalRoot !== undefined) requireAbsolutePath(value.globalRoot, `${where}.globalRoot`, issues);
}

/** Validates the optional `managedInstall` field: a marker kind, layout, and absolute root. */
function managedInstallIssues(value: unknown, where: string, issues: string[]): void {
  if (!isObject(value)) {
    issues.push(`${where} must be an object`);
    return;
  }
  requireNonEmptyString(value.kind, `${where}.kind`, issues);
  requireNonEmptyString(value.layout, `${where}.layout`, issues);
  requireAbsolutePath(value.root, `${where}.root`, issues);
}

/** Fingerprints and before-image addresses are sha256 hex, the only hash form Tret writes. */
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireString(raw: unknown, where: string, issues: string[]): void {
  if (typeof raw !== "string") issues.push(`${where} must be a string`);
}

function requireNonEmptyString(raw: unknown, where: string, issues: string[]): void {
  if (typeof raw !== "string" || raw.length === 0) issues.push(`${where} must be a non-empty string`);
}

/** Entry paths are absolute, because uninstall resolves them without a working directory. */
function requireAbsolutePath(raw: unknown, where: string, issues: string[]): void {
  if (typeof raw !== "string" || !raw.startsWith("/")) issues.push(`${where} must be an absolute path`);
}

function requireSha256(raw: unknown, where: string, issues: string[]): void {
  if (typeof raw !== "string" || !SHA256_PATTERN.test(raw)) issues.push(`${where} must be a sha256 hex string`);
}

/** Permission bits only; `0o7777` is the most a POSIX mode can carry. */
function requireMode(raw: unknown, where: string, issues: string[]): void {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 0o7777) {
    issues.push(`${where} must be permission bits`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
