import { PRIVATE_FILE_MODE, isErrno, readFileIfExists, writeFileExclusive } from "./atomic";
import { lstatSync, opendirSync } from "node:fs";
import type { DurableOperation } from "./operation-log";
import { NativeDirectory } from "./native-filesystem";
import type { RecoveryRetention } from "./recovery-retention";
import { join } from "node:path";

export const OPERATION_INLINE_BYTES = 256 * 1024;
export const OPERATION_CHUNK_BYTES = 1024 * 1024;
export const OPERATION_LOGICAL_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = 1024;
const HASH = /^[a-f0-9]{64}$/;
const PART = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([a-f0-9]{64})\.part$/;
type Part = { hash: string; bytes: number };
export type OperationEnvelope = {
  version: 2;
  id: string;
  inline?: unknown;
  parts?: Part[];
  bytes: number;
  retained: Part[];
  pins: string[];
};
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export function chunkOwner(name: string): string | undefined {
  return PART.exec(name)?.[1];
}
export function chunkName(id: string, digest: string): string {
  return `${id}.${digest}.part`;
}
/** Stable inventories precede variable lifecycle metadata so stage changes reuse their chunks. */
export function operationText(operation: DurableOperation): string {
  const { priorRecords, baseline, capture, checkpoint, application, ...metadata } = operation;
  return JSON.stringify({ priorRecords, baseline, capture, checkpoint, application, ...metadata });
}

export function isEnvelope(value: unknown, id: string): value is OperationEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<OperationEnvelope>;
  const part = (p: Part) =>
    p &&
    typeof p.hash === "string" &&
    HASH.test(p.hash) &&
    Number.isSafeInteger(p.bytes) &&
    p.bytes > 0 &&
    p.bytes <= OPERATION_CHUNK_BYTES;
  if (
    v.version !== 2 ||
    v.id !== id ||
    !Number.isSafeInteger(v.bytes) ||
    v.bytes! <= 0 ||
    v.bytes! > OPERATION_LOGICAL_BYTES ||
    !Array.isArray(v.retained) ||
    v.retained.length > MAX_PARTS ||
    !v.retained.every(part) ||
    new Set(v.retained.map((p) => p.hash)).size !== v.retained.length ||
    !Array.isArray(v.pins) ||
    !v.pins.every((pin) => typeof pin === "string" && HASH.test(pin))
  )
    return false;
  if (v.inline !== undefined) return v.parts === undefined && v.bytes! <= 16 * 1024 * 1024;
  return (
    Array.isArray(v.parts) &&
    v.parts.length > 0 &&
    v.parts.length <= 64 &&
    v.parts.every(part) &&
    v.parts.reduce((n, p) => n + p.bytes, 0) === v.bytes &&
    v.parts.every((p) => v.retained!.some((r) => r.hash === p.hash && r.bytes === p.bytes))
  );
}

export function readEnvelope(directory: string, envelope: OperationEnvelope, check: () => void = () => {}): unknown {
  check();
  if (envelope.inline !== undefined) {
    if (Buffer.byteLength(JSON.stringify(envelope.inline)) !== envelope.bytes)
      throw new Error("invalid inline operation length");
    return envelope.inline;
  }
  const bytes = Buffer.alloc(envelope.bytes);
  let offset = 0;
  for (const part of envelope.parts!) {
    check();
    const chunk = readFileIfExists(join(directory, chunkName(envelope.id, part.hash)), OPERATION_CHUNK_BYTES);
    if (!chunk || chunk.byteLength !== part.bytes || hash(chunk) !== part.hash)
      throw new Error("missing or corrupt operation chunk; evidence retained");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  check();
  return JSON.parse(bytes.toString("utf8"));
}

/** New chunks are durable before the root. A failed publication preserves both the old root and available new parts. */
export function prepareEnvelope(
  directory: string,
  id: string,
  bytes: Uint8Array,
  pins: string[],
  previous: OperationEnvelope | undefined,
  retention: RecoveryRetention,
): OperationEnvelope {
  if (bytes.byteLength > OPERATION_LOGICAL_BYTES) throw new Error("operation evidence exceeds the 64 MiB logical limit");
  const retained = new Map((previous?.retained ?? []).map((part) => [part.hash, part]));
  const envelope: OperationEnvelope = { version: 2, id, bytes: bytes.byteLength, retained: [], pins: [] };
  if (bytes.byteLength <= OPERATION_INLINE_BYTES) envelope.inline = JSON.parse(new TextDecoder().decode(bytes));
  else {
    envelope.parts = [];
    for (let offset = 0; offset < bytes.byteLength; offset += OPERATION_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + OPERATION_CHUNK_BYTES);
      const part = { hash: hash(chunk), bytes: chunk.byteLength };
      retained.set(part.hash, part);
      if (retained.size > MAX_PARTS)
        throw new Error(
          "operation retained chunk limit 1024; explicitly discard evidence or retain it for manual reconciliation",
        );
      envelope.parts.push(part);
      const path = join(directory, chunkName(id, part.hash));
      const existing = readFileIfExists(path, OPERATION_CHUNK_BYTES);
      if (existing) {
        if (existing.byteLength !== part.bytes || hash(existing) !== part.hash)
          throw new Error("operation chunk content address mismatch; evidence retained");
      } else {
        retention.beforeWrite(path, chunk.byteLength);
        writeFileExclusive(path, chunk, PRIVATE_FILE_MODE);
      }
    }
  }
  envelope.retained = [...retained.values()];
  envelope.pins = [...new Set([...(retained.size ? (previous?.pins ?? []) : []), ...pins])];
  return envelope;
}

/** Only an explicit durable discard authorizes removing its operation's encoding artifacts. */
export function removeOperationChunks(directory: string, id: string, maxWorkMs: number): void {
  const deadline = performance.now() + maxWorkMs;
  const parent = new NativeDirectory(directory);
  try {
    const named = lstatSync(directory, { bigint: true });
    if (String(named.dev) !== parent.identity.dev || String(named.ino) !== parent.identity.ino)
      throw new Error("operation directory changed; chunks retained");
    const dir = opendirSync(directory, { bufferSize: 32 });
    const retained: string[] = [];
    let unverified = 0;
    try {
      for (;;) {
        if (performance.now() >= deadline) throw new Error("operation chunk disposal deadline; retry the same discarded id");
        const entry = dir.readSync();
        if (!entry) break;
        if (chunkOwner(entry.name) !== id) continue;
        const node = parent.inspect(entry.name);
        if (!node) continue;
        let verified = false;
        try {
          verified =
            node.kind === "file" &&
            node.links === "1" &&
            parent.hash(entry.name, node, OPERATION_CHUNK_BYTES) === PART.exec(entry.name)![2];
        } catch {
          /* Unreadable or oversized content remains for manual reconciliation. */
        }
        if (!verified) {
          unverified++;
          if (retained.length < 32) retained.push(join(directory, entry.name));
          continue;
        }
        parent.unlink(entry.name, "file");
      }
    } finally {
      dir.closeSync();
    }
    parent.sync();
    if (unverified)
      throw new Error(
        `unverified operation chunk retained: ${retained.join(", ")}${unverified > retained.length ? `; ${unverified - retained.length} more (listed by recover)` : ""}; manual reconciliation required`,
      );
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  } finally {
    parent.close();
  }
}
