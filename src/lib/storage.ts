import type { RecordV3 } from "../types";

/** Content address of a stored blob: the sha256 hex of its bytes. */
export type BlobId = string;

/** A stored blob's address and size in bytes. */
export type BlobRef = {
  id: BlobId;
  size: number;
};

/**
 * Loads and persists v3 records and their content-addressed before-image blobs. The real
 * filesystem-backed implementation (atomic writes, restrictive permissions, size limits, v2→v3
 * migration) lands in phase 6; this freezes the contract so capture and uninstall can target it.
 */
export interface Storage {
  /** Loads every record, migrating v2 records to v3 where applicable. */
  loadRecords(): Promise<RecordV3[]>;
  /** Atomically persists one record, replacing any record with the same id. */
  saveRecord(record: RecordV3): Promise<void>;
  /** Removes one record by id; an unknown id is a no-op. */
  removeRecord(id: string): Promise<void>;
  /** Stores bytes under their content address and returns the reference. */
  putBlob(content: Uint8Array): Promise<BlobRef>;
  /** Reads a blob by content address, or undefined when it is missing. */
  getBlob(id: BlobId): Promise<Uint8Array | undefined>;
  /** Deletes every blob not in `keep`; returns the addresses removed. */
  gc(keep: Iterable<BlobId>): Promise<BlobId[]>;
}

/** Collects the before-image addresses every record references; the `keep` input to `Storage.gc`. */
export function referencedBlobs(records: Iterable<RecordV3>): BlobId[] {
  const ids = new Set<BlobId>();
  for (const record of records) {
    for (const entry of record.mutated) {
      if (entry.beforeBlob !== undefined) ids.add(entry.beforeBlob);
    }
    for (const entry of record.deleted) {
      if (entry.beforeBlob !== undefined) ids.add(entry.beforeBlob);
    }
  }
  return [...ids];
}
