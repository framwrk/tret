import type { EffectEvidence, RecordV3, RecordV4 } from "../types";

/** Content address of a stored blob: the sha256 hex of its bytes. */
export type BlobId = string;

/** A stored blob's address and size in bytes. */
export type BlobRef = {
  id: BlobId;
  size: number;
};

/**
 * Candidate records and content-addressed before-images. FileStorage normalizes legacy evidence
 * to v4 and enforces revisions/operation leases; injected stores may omit storage-managed fields.
 */
export interface Storage {
  /** Loads records, interpreting legacy evidence in memory without persisting migration. */
  loadRecords(): Promise<RecordV3[]>;
  /** Persists a new record or compares the revision read earlier before replacing an existing id. */
  saveRecord(record: RecordV3, origin?: EffectEvidence["origin"]): Promise<RecordV4 | void>;
  /** Removes one record at the expected revision; an absent id is a no-op only without an expectation. */
  removeRecord(id: string, expectedRevision?: number): Promise<void>;
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
