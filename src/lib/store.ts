// The filesystem-backed `Storage` implementation (plan section 4, phase 6): content-addressed
// before-image blobs under `~/.tret/objects/` and a validated, atomically written v3 records file.
//
// Safety properties this layer owns:
// - Blobs are named by the sha256 of their bytes, written atomically, deduplicated by content, and
//   kept at owner-only permissions. Blobs over the configured limit are refused, so a caller can
//   still record the mutation while leaving `beforeBlob` unset and the entry non-restorable (D2).
// - The records file is written with a temp-file-and-rename and validated on read; a corrupt file
//   raises instead of being overwritten, so a failed read or migration never erases user records.
// - Garbage collection deletes only blobs no record references, tolerates an interrupted run, and
//   can spare blobs written inside a grace window so an in-flight install cannot lose one.
//
// This owns the v3 records file. The legacy commands still read the v2 helpers in `records.ts`
// until phase 9 rewires them, so nothing constructs this store yet; tests exercise it directly.

import type { BlobId, BlobRef, Storage } from "./storage";
import { OBJECTS_PATH, RECORDS_PATH } from "../constants";
import { PRIVATE_FILE_MODE, isErrno, isTemporaryName, readFileIfExists, writeFileAtomic } from "./atomic";
import type { RecordFileV3, RecordV3 } from "../types";
import { RecordMigrationError, isV3Record, migrateRecordFileV2ToV3 } from "./records";
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { BackupPolicy } from "./capture/normalize";
import { homedir } from "node:os";
import { join } from "node:path";
import { referencedBlobs } from "./storage";

/** Default cap on one before-image; larger files are recorded as mutations but not stored (D2). */
export const DEFAULT_BACKUP_SIZE_LIMIT_BYTES = 1024 * 1024;

/**
 * Before-image backups are **off by default** (D2). A caller must opt in per install or in config
 * before any content is captured; hashes are still recorded so uninstall can detect and report.
 */
export const DEFAULT_BACKUP_POLICY: BackupPolicy = {
  enabled: false,
  sizeLimitBytes: DEFAULT_BACKUP_SIZE_LIMIT_BYTES,
};

/** Default GC grace window; see `FileStorageOptions.gcGraceMs`. */
export const DEFAULT_GC_GRACE_MS = 0;

const BLOB_ID_PATTERN = /^[a-f0-9]{64}$/;

/** Raised when a before-image exceeds the configured backup size limit. */
export class BlobTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(`before-image is ${size} bytes, above the ${limit}-byte backup limit`);
    this.name = "BlobTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

/** Raised when a blob file exists but its bytes do not hash to its content address. */
export class BlobCorruptionError extends Error {
  readonly id: BlobId;

  constructor(id: BlobId) {
    super(`blob ${id} does not match its content address`);
    this.name = "BlobCorruptionError";
    this.id = id;
  }
}

/** Raised when the records file cannot be parsed or migrated, so it is never silently overwritten. */
export class RecordsCorruptionError extends Error {
  readonly path: string;
  readonly issues: string[];

  constructor(path: string, message: string, issues: string[] = []) {
    super(`corrupt records file at ${path}: ${message}`);
    this.name = "RecordsCorruptionError";
    this.path = path;
    this.issues = issues;
  }
}

/** Raised when `saveRecord` is handed something that is not a valid v3 record. */
export class InvalidRecordError extends Error {
  constructor(message = "record is not a valid v3 record") {
    super(message);
    this.name = "InvalidRecordError";
  }
}

export type FileStorageOptions = {
  /** Directory whose `.tret` subdirectory holds records and blobs; defaults to `$HOME`. */
  homeDir?: string;
  /** Before-image backup policy (D2); defaults to off with `DEFAULT_BACKUP_SIZE_LIMIT_BYTES`. */
  backups?: BackupPolicy;
  /**
   * Blobs modified within this many milliseconds are spared by GC, so a blob written by a
   * concurrent install after the record snapshot is not swept. Defaults to `DEFAULT_GC_GRACE_MS`.
   */
  gcGraceMs?: number;
  /** Clock in milliseconds, injectable so grace windows and quarantine names are testable. */
  now?: () => number;
};

/**
 * Records and blobs on disk. The record file lives at `~/.tret/records.json` and blobs under
 * `~/.tret/objects/`; both use owner-only permissions and atomic writes.
 */
export class FileStorage implements Storage {
  /** The home directory this store is rooted at. */
  readonly homeDir: string;
  /** The backup policy in force; `enabled` is false unless the caller opted in (D2). */
  readonly backups: BackupPolicy;
  /** Absolute path of the v3 records file. */
  readonly recordsPath: string;
  /** Absolute path of the content-addressed blob directory. */
  readonly objectsDir: string;

  private readonly gcGraceMs: number;
  private readonly now: () => number;

  constructor(options: FileStorageOptions = {}) {
    this.homeDir = options.homeDir ?? process.env.HOME ?? homedir();
    this.backups = options.backups ?? DEFAULT_BACKUP_POLICY;
    this.gcGraceMs = options.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.recordsPath = join(this.homeDir, RECORDS_PATH);
    this.objectsDir = join(this.homeDir, OBJECTS_PATH);
  }

  /** Whether before-image content is captured (D2). */
  get backupsEnabled(): boolean {
    return this.backups.enabled;
  }

  /**
   * Loads every record, upgrading a v2 file to v3 the first time it is read. A missing file is no
   * records; a file that cannot be parsed or migrated raises `RecordsCorruptionError` and is left
   * untouched, so a corrupt read never becomes a silent erase.
   */
  async loadRecords(): Promise<RecordV3[]> {
    const raw = readFileIfExists(this.recordsPath);
    if (raw === undefined) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new RecordsCorruptionError(this.recordsPath, "file is not valid JSON");
    }

    let file: RecordFileV3;
    try {
      file = migrateRecordFileV2ToV3(parsed);
    } catch (error) {
      if (error instanceof RecordMigrationError) {
        throw new RecordsCorruptionError(this.recordsPath, error.message, error.issues);
      }
      throw error;
    }

    // Persist the upgrade once. The atomic write leaves the original intact if it fails.
    if (!isVersion3File(parsed)) {
      this.writeRecords(file.records);
    }

    return file.records;
  }

  /** Atomically persists one record, replacing any record with the same id. */
  async saveRecord(record: RecordV3): Promise<void> {
    if (!isV3Record(record)) throw new InvalidRecordError();
    const records = await this.loadRecords();
    const next = records.filter((existing) => existing.id !== record.id);
    next.push(record);
    this.writeRecords(next);
  }

  /** Removes one record by id; an unknown id is a no-op and leaves the file untouched. */
  async removeRecord(id: string): Promise<void> {
    const records = await this.loadRecords();
    const next = records.filter((existing) => existing.id !== id);
    if (next.length === records.length) return;
    this.writeRecords(next);
  }

  /**
   * Stores `content` under its sha256 address, deduplicating by content and refusing anything above
   * the configured size limit. Existing bytes that fail their own integrity check are repaired.
   */
  async putBlob(content: Uint8Array): Promise<BlobRef> {
    const size = content.byteLength;
    if (size > this.backups.sizeLimitBytes) {
      throw new BlobTooLargeError(size, this.backups.sizeLimitBytes);
    }
    const id = hashContent(content);
    if (!this.blobIsValid(id)) {
      writeFileAtomic(this.blobPath(id), content, PRIVATE_FILE_MODE);
    }
    return { id, size };
  }

  /**
   * Reads a blob by content address. A missing (or malformed) address is `undefined`; a file whose
   * bytes no longer hash to its name raises `BlobCorruptionError` rather than returning bad data.
   */
  async getBlob(id: BlobId): Promise<Uint8Array | undefined> {
    if (!BLOB_ID_PATTERN.test(id)) return undefined;
    const bytes = readFileIfExists(this.blobPath(id));
    if (bytes === undefined) return undefined;
    if (hashContent(bytes) !== id) throw new BlobCorruptionError(id);
    return bytes;
  }

  /**
   * Deletes every blob not in `keep` and returns the addresses removed. Unlinking one file at a
   * time makes an interrupted run consistent and safely retriable: a live blob is never in the
   * sweep set, so re-running only finishes what was left.
   */
  async gc(keep: Iterable<BlobId>): Promise<BlobId[]> {
    const kept = new Set(keep);
    const removed: BlobId[] = [];
    const cutoff = this.now() - this.gcGraceMs;

    for (const entry of this.listObjects()) {
      const path = join(this.objectsDir, entry.name);
      if (isTemporaryName(entry.name)) {
        // A temp file means a write was interrupted before its rename; the blob it would have
        // become is either already present or never referenced. A recent one may belong to a
        // writer still in flight, so the grace window protects it too.
        if (!this.isFresh(path, cutoff)) rmSync(path, { force: true });
        continue;
      }
      if (!entry.isFile() || !BLOB_ID_PATTERN.test(entry.name)) continue;
      if (kept.has(entry.name)) continue;
      if (this.isFresh(path, cutoff)) continue;
      rmSync(path, { force: true });
      removed.push(entry.name);
    }

    return removed.sort();
  }

  /**
   * The safe production entry point: garbage-collects against the references every stored record
   * makes, so only blobs no record references are ever deleted.
   */
  async gcUnreferenced(): Promise<BlobId[]> {
    return this.gc(referencedBlobs(await this.loadRecords()));
  }

  /**
   * Stores a before-image only when backups are enabled and it fits the size limit (D2). When it
   * returns `undefined` the caller records the mutation without a `beforeBlob`, which marks the
   * entry detectable but not restorable.
   */
  async captureBeforeImage(content: Uint8Array): Promise<BlobRef | undefined> {
    if (!this.backups.enabled) return undefined;
    if (content.byteLength > this.backups.sizeLimitBytes) return undefined;
    return this.putBlob(content);
  }

  /**
   * Moves a corrupt records file aside and returns its new path, or `undefined` when the file is
   * readable. This is the explicit recovery step after `RecordsCorruptionError`; nothing is
   * quarantined automatically, and the original bytes are preserved.
   */
  async quarantineCorruptRecords(): Promise<string | undefined> {
    if (readFileIfExists(this.recordsPath) === undefined) return undefined;
    try {
      await this.loadRecords();
      return undefined;
    } catch (error) {
      if (!(error instanceof RecordsCorruptionError)) throw error;
    }

    const target = `${this.recordsPath}.corrupt-${quarantineStamp(this.now())}`;
    renameSync(this.recordsPath, target);
    return target;
  }

  /** Whether a stored blob for `id` exists and its bytes still hash to that address. */
  private blobIsValid(id: BlobId): boolean {
    const existing = readFileIfExists(this.blobPath(id));
    return existing !== undefined && hashContent(existing) === id;
  }

  private blobPath(id: BlobId): string {
    return join(this.objectsDir, id);
  }

  /** Whether a file was modified inside the GC grace window; always false when no grace is set. */
  private isFresh(path: string, cutoff: number): boolean {
    return this.gcGraceMs > 0 && statSync(path).mtimeMs > cutoff;
  }

  private writeRecords(records: RecordV3[]): void {
    const file: RecordFileV3 = { version: 3, records };
    writeFileAtomic(this.recordsPath, JSON.stringify(file, null, 2), PRIVATE_FILE_MODE);
  }

  private listObjects(): Array<{ name: string; isFile(): boolean }> {
    try {
      return readdirSync(this.objectsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  }
}

/** The sha256 hex of `bytes`, the content address used for both blob ids and record hashes. */
function hashContent(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function isVersion3File(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { version?: unknown }).version === 3;
}

/** A filename-safe UTC timestamp for quarantined files. */
function quarantineStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}
