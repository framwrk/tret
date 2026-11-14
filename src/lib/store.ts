// The filesystem-backed `Storage` implementation (plan section 4, phase 6): content-addressed
// before-image blobs under `~/.tret/objects/` and a validated, atomically written v4 records file.
//
// Safety properties this layer owns:
// - Blobs are named by the sha256 of their bytes, written atomically, deduplicated by content, and
//   kept at owner-only permissions. Blobs over the configured limit are refused, so a caller can
//   still record the mutation while leaving `beforeBlob` unset and the entry non-restorable (D2).
// - The records file is written with a temp-file-and-rename and validated on read; a corrupt file
//   raises instead of being overwritten, so a failed read or migration never erases user records.
// - Reads interpret legacy records without rewriting them. The first mutation preserves the raw
//   original before committing a migrated file under the records lock.
// - Updates serialize their read/modify/write step under an exclusive lease. Age never steals a
//   lease inside the kernel operation lease; writes also compare record revisions.
// - Command GC preserves blobs when recovery entries leave references unknown. A grace window
//   remains an extra retention policy; durable operations pin unpublished before-images first.

import type { BlobId, BlobRef, Storage } from "./storage";
import type { EffectEvidence, RecordFileV4, RecordV3, RecordV4 } from "../types";
import { OBJECTS_PATH, RECORDS_PATH } from "../constants";
import {
  PRIVATE_FILE_MODE,
  assertDirectoryIfExists,
  ensurePrivateDir,
  flushDirectory,
  flushFile,
  isErrno,
  isTemporaryName,
  readFileIfExists,
  writeFileAtomic,
  writeFileExclusive,
} from "./atomic";
import { RecordMigrationError, isV3Record } from "./records";
import { basename, dirname, join } from "node:path";
import { currentOperationToken, withOperationLease } from "./operation-lease";
import { observedRecord, readRecordFile, validateRecordFileV4 } from "./records-v4";
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { BackupPolicy } from "./capture/normalize";
import { OperationLog } from "./operation-log";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
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

/**
 * Grace window `collectUnreferencedBlobs` uses after a completed command. It spares recent blobs
 * whose record may not yet be saved; operations lasting longer still need durable pins.
 */
export const COMMAND_GC_GRACE_MS = 60_000;

/** Default bounded wait for the records lock; see `FileStorageOptions.lockTimeoutMs`. */
export const DEFAULT_RECORDS_LOCK_TIMEOUT_MS = 5000;

/** How long to wait between records-lock attempts. */
const RECORDS_LOCK_RETRY_MS = 25;

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

/** Raised when an existing records lease remains past the configured wait; its owner may be unknown. */
export class RecordsLockedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`records have an existing lease; resolve its owner before retrying: ${path}`);
    this.name = "RecordsLockedError";
    this.path = path;
  }
}

export class RecordRevisionError extends Error {
  constructor(readonly id: string) {
    super(`record changed after it was read: ${id}; reload and rebuild the plan`);
    this.name = "RecordRevisionError";
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
  /** Bounded wait for the records lock before an update fails closed; defaults to `DEFAULT_RECORDS_LOCK_TIMEOUT_MS`. */
  lockTimeoutMs?: number;
  /** Clock in milliseconds, injectable so grace windows and quarantine names are testable. */
  now?: () => number;
};

/**
 * Records and blobs on disk. The record file lives at `~/.tret/records.json` and blobs under
 * `~/.tret/objects/`; both use owner-only permissions and atomic writes, and every record update
 * holds the `records.json.lock` file so concurrent commands serialize instead of losing records.
 */
export class FileStorage implements Storage {
  /** The home directory this store is rooted at. */
  readonly homeDir: string;
  /** The backup policy in force; `enabled` is false unless the caller opted in (D2). */
  readonly backups: BackupPolicy;
  /** Absolute path of the current records file. */
  readonly recordsPath: string;
  /** Absolute path of the content-addressed blob directory. */
  readonly objectsDir: string;
  readonly operations: OperationLog;

  private readonly gcGraceMs: number;
  private readonly lockTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: FileStorageOptions = {}) {
    this.homeDir = options.homeDir ?? process.env.HOME ?? homedir();
    this.backups = options.backups ?? DEFAULT_BACKUP_POLICY;
    this.gcGraceMs = options.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_RECORDS_LOCK_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.recordsPath = join(this.homeDir, RECORDS_PATH);
    this.objectsDir = join(this.homeDir, OBJECTS_PATH);
    this.operations = new OperationLog(dirname(this.recordsPath));
  }

  get inOperation(): boolean {
    return currentOperationToken(dirname(this.recordsPath)) !== undefined;
  }

  /** Call before the command's record read; nested update/install/cleanup calls reuse the lease. */
  async withOperation<T>(work: () => Promise<T>, recovery = false): Promise<T> {
    if (this.inOperation) return work();
    return withOperationLease(dirname(this.recordsPath), async () => {
      if (!recovery) this.operations.requireReconciled();
      return work();
    }, this.lockTimeoutMs);
  }

  /** Whether before-image content is captured (D2). */
  get backupsEnabled(): boolean {
    return this.backups.enabled;
  }

  /**
   * Loads every record, interpreting v2 as v3 in memory without changing disk. A missing file is no
   * records; a file that cannot be parsed or migrated raises `RecordsCorruptionError` and is left
   * untouched, so a corrupt read never becomes a silent erase.
   */
  async loadRecords(): Promise<RecordV4[]> {
    return (await this.loadFile()).records;
  }

  private async loadFile(): Promise<RecordFileV4> {
    assertDirectoryIfExists(dirname(this.recordsPath));
    const raw = readFileIfExists(this.recordsPath);
    if (raw === undefined) return { version: 4, sequence: 0, records: [] };

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new RecordsCorruptionError(this.recordsPath, "file is not valid JSON");
    }

    let file: RecordFileV4;
    try {
      file = readRecordFile(parsed);
    } catch (error) {
      if (error instanceof RecordMigrationError) {
        throw new RecordsCorruptionError(this.recordsPath, error.message, error.issues);
      }
      throw error;
    }

    return file;
  }

  /** Commit the incompatible format barrier before external work; older readers then refuse it. */
  async prepareCurrentFormat(): Promise<void> {
    await this.withOperation(() => this.withRecordsLock(async () => {
      const file = await this.loadFile();
      const raw = readFileIfExists(this.recordsPath);
      if (raw && isVersion4File(JSON.parse(new TextDecoder().decode(raw)))) return;
      this.writeRecords(file.records, file.sequence);
    }));
  }

  /**
   * Atomically persists one record after comparing its revision with the current snapshot. New ids
   * require an absent expected revision; existing ids require the exact revision read earlier.
   */
  async saveRecord(record: RecordV3, origin: EffectEvidence["origin"] = record.source === "find" ? "find" : "capture"): Promise<RecordV4> {
    if (!isV3Record(record)) throw new InvalidRecordError();
    return this.withOperation(() => this.withRecordsLock(async () => {
      const file = await this.loadFile();
      const existing = file.records.find((candidate) => candidate.id === record.id);
      if (existing ? existing.revision !== record.revision : record.revision !== undefined) throw new RecordRevisionError(record.id);
      const sequence = file.sequence + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("record revision sequence is exhausted");
      const saved = observedRecord(record, sequence, origin, true);
      const next = file.records.filter((candidate) => candidate.id !== record.id);
      next.push(saved);
      this.writeRecords(next, sequence);
      return saved;
    }));
  }

  /** Removes one record by id under the records lock; an unknown id is a no-op and leaves the file untouched. */
  async removeRecord(id: string, expectedRevision?: number): Promise<void> {
    await this.withOperation(() => this.withRecordsLock(async () => {
      const file = await this.loadFile();
      const existing = file.records.find((candidate) => candidate.id === id);
      if (!existing) {
        if (expectedRevision !== undefined) throw new RecordRevisionError(id);
        return;
      }
      if (existing.revision !== expectedRevision) throw new RecordRevisionError(id);
      this.writeRecords(file.records.filter((candidate) => candidate.id !== id), file.sequence + 1);
    }));
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
    ensurePrivateDir(dirname(this.recordsPath));
    assertDirectoryIfExists(this.objectsDir);
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
    this.assertBlobDirectories();
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
  private async sweep(keep: Iterable<BlobId>): Promise<BlobId[]> {
    this.assertBlobDirectories();
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
    return this.gc([]);
  }

  async gc(extraKeep: Iterable<BlobId>): Promise<BlobId[]> {
    return this.withOperation(() => this.withRecordsLock(async () => {
      // Corrupt recovery entries can contain references validation cannot recover. Never mistake
      // that unknown graph for an empty store. Legacy v2 originals cannot reference v3 blobs.
      const base = basename(this.recordsPath);
      if (readdirSync(dirname(this.recordsPath)).some((name) => name.startsWith(`${base}.corrupt-`))) return [];
      const keep = new Set([...extraKeep, ...referencedBlobs(await this.loadRecords()), ...this.operations.pinnedBlobs()]);
      for (const name of readdirSync(dirname(this.recordsPath))) {
        if (!name.startsWith(`${base}.legacy-v3-`)) continue;
        const bytes = readFileIfExists(join(dirname(this.recordsPath), name));
        if (!bytes) return [];
        try {
          for (const id of referencedBlobs(readRecordFile(JSON.parse(new TextDecoder().decode(bytes))).records)) keep.add(id);
        } catch { return []; }
      }
      return this.sweep(keep);
    }), true);
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
    assertDirectoryIfExists(dirname(this.recordsPath));
    if (readFileIfExists(this.recordsPath) === undefined) return undefined;
    return this.withOperation(() => this.withRecordsLock(async () => {
      try {
        await this.loadRecords();
        return undefined;
      } catch (error) {
        if (!(error instanceof RecordsCorruptionError)) throw error;
      }

      const target = `${this.recordsPath}.corrupt-${quarantineStamp(this.now())}`;
      if (readFileIfExists(target) !== undefined) {
        throw new RecordsCorruptionError(target, "recovery file already exists; original records were left untouched");
      }
      renameSync(this.recordsPath, target);
      flushDirectory(dirname(this.recordsPath));
      return target;
    }), true);
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

  private writeRecords(records: RecordV4[], sequence: number): void {
    const original = readFileIfExists(this.recordsPath);
    const previous: unknown = original === undefined ? undefined : JSON.parse(new TextDecoder().decode(original));
    if (original !== undefined && !isVersion4File(previous)) {
      const version = typeof previous === "object" && previous !== null && "version" in previous ? previous.version : undefined;
      if (version !== 2 && version !== 3) throw new RecordsCorruptionError(this.recordsPath, "unsupported migration source");
      const backup = `${this.recordsPath}.legacy-v${version}-${hashContent(original)}.json`;
      try {
        writeFileExclusive(backup, original, PRIVATE_FILE_MODE);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const existing = readFileIfExists(backup);
        if (existing === undefined || hashContent(existing) !== hashContent(original)) {
          throw new RecordsCorruptionError(backup, "legacy original does not match its content address");
        }
        flushFile(backup);
      }
    }
    const file = validateRecordFileV4({ version: 4, sequence, records });
    writeFileAtomic(this.recordsPath, JSON.stringify(file, null, 2), PRIVATE_FILE_MODE);
  }

  /**
   * Runs one read-modify-write under an exclusive lock file beside the records, so two `tret`
   * processes cannot both read the same snapshot and have the later write discard the earlier
   * record. The file is created with `wx`, which is atomic: exactly one contender wins and the
   * others see `EEXIST`. Age never authorizes stealing a lock: an interrupted or unknown owner
   * requires explicit recovery. Contention past `lockTimeoutMs` fails closed.
   */
  private async withRecordsLock<T>(work: () => Promise<T>): Promise<T> {
    // Once the incompatible barrier is committed, all supported writers hold the operation lease.
    // Do not create a second persistent lease that SIGKILL could strand during an ordinary save.
    // The old exclusive protocol is needed only while migrating an older/absent store.
    const raw = readFileIfExists(this.recordsPath);
    if (raw !== undefined) {
      let file: unknown;
      try { file = JSON.parse(new TextDecoder().decode(raw)); } catch { /* Corruption is handled by work(). */ }
      if (isVersion4File(file)) return work();
    }
    const lockPath = `${this.recordsPath}.lock`;
    ensurePrivateDir(dirname(this.recordsPath));
    const deadline = performance.now() + this.lockTimeoutMs;
    const owner = `${process.pid}\n${randomUUID()}\n`;

    for (;;) {
      try {
        writeFileExclusive(lockPath, owner, PRIVATE_FILE_MODE);
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (performance.now() >= deadline) throw new RecordsLockedError(lockPath);
        await Bun.sleep(RECORDS_LOCK_RETRY_MS);
      }
    }

    try {
      return await work();
    } finally {
      try {
        const current = readFileIfExists(lockPath);
        if (current !== undefined && new TextDecoder().decode(current) === owner) rmSync(lockPath);
      } catch {
        // Never remove an uninspectable/replaced lease. Recovery must resolve it explicitly.
      }
    }
  }

  private assertBlobDirectories(): void {
    assertDirectoryIfExists(dirname(this.recordsPath));
    assertDirectoryIfExists(this.objectsDir);
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

/**
 * The best-effort production entry point: collects every blob no stored record references and
 * returns the addresses removed. The reference read and sweep share the records lease with writers
 * and quarantine. This wrapper never raises, so a failed sweep leaves blobs for the next run instead
 * of turning a completed command into a failure. The default store spares fresh orphans for 60
 * seconds; longer-running operations still need durable pins for their unpublished references.
 */
export async function collectUnreferencedBlobs(
  storage: Pick<FileStorage, "gcUnreferenced"> = new FileStorage({ gcGraceMs: COMMAND_GC_GRACE_MS }),
): Promise<BlobId[]> {
  try {
    return await storage.gcUnreferenced();
  } catch {
    return [];
  }
}

/** The sha256 hex of `bytes`, the content address used for both blob ids and record hashes. */
function hashContent(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function isVersion4File(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { version?: unknown }).version === 4;
}

/** A filename-safe UTC timestamp for quarantined files. */
function quarantineStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}
