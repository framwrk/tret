import { NativeDirectory, type NodeIdentity, sameNode } from "./native-filesystem";
import { assertDirectoryIfExists, isErrno, readFileIfExists } from "./atomic";
import { basename, dirname, join } from "node:path";
import type { OperationLog } from "./operation-log";
import { currentOperationToken } from "./operation-lease";
import { lstatSync } from "node:fs";
import { readRecordFile } from "./records-v4";

const ORIGINAL = /^original-v([23]):([a-f0-9]{64})$/;
const NAME = /^records\.json\.legacy-v([23])-([a-f0-9]{64})\.json$/;
const STAGED_NAME = /^records\.json\.corrupt-discard-original-v([23])-([a-f0-9]{64})$/;
const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;
export function originalId(name: string): string | undefined {
  const match = NAME.exec(name) ?? STAGED_NAME.exec(name);
  return match ? `original-v${match[1]}:${match[2]}` : undefined;
}

export function inspectOriginal(log: OperationLog, id: string) {
  const match = ORIGINAL.exec(id);
  if (!match) throw new Error("original selector must be original-v2:<sha256> or original-v3:<sha256>");
  assertDirectoryIfExists(log.stateDir);
  const source = join(log.stateDir, `records.json.legacy-v${match[1]}-${match[2]}.json`);
  const staged = join(log.stateDir, `records.json.corrupt-discard-original-v${match[1]}-${match[2]}`);
  const exists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  };
  const hasSource = exists(source),
    hasStage = exists(staged);
  if (hasSource && hasStage)
    throw new Error("both original and interrupted-discard evidence exist; preserve both for manual reconciliation");
  const path = hasSource ? source : staged;
  if (!hasSource && !hasStage) return undefined;
  const parent = new NativeDirectory(log.stateDir);
  try {
    const node = parent.inspect(basename(path));
    if (!node) return undefined;
    if (node.kind !== "file" || node.links !== "1" || Number(node.size) > MAX_ORIGINAL_BYTES)
      throw new Error("original is oversized or not a supported private regular file; evidence retained");
    const verified = parent.hash(basename(path), node, MAX_ORIGINAL_BYTES) === match[2];
    let formatValid = false;
    if (verified) {
      try {
        const bytes = readFileIfExists(path, MAX_ORIGINAL_BYTES);
        const file = bytes && JSON.parse(new TextDecoder().decode(bytes));
        if (file?.version === Number(match[1])) {
          readRecordFile(file);
          formatValid = true;
        }
      } catch {
        /* Never reinterpret an unreadable/corrupt original as an empty graph. */
      }
    }
    return { id, version: Number(match[1]), path, bytes: Number(node.size), verified, formatValid };
  } finally {
    parent.close();
  }
}

/** Moves into a private quarantine before verification/unlink, preserving substituted bytes. */
function removeRecoveryFile(stateDir: string, path: string, expectedHash: string, maxBytes: number, stageName: string): void {
  if (!currentOperationToken(stateDir)) throw new Error("recovery deletion requires the store operation lease");
  assertDirectoryIfExists(stateDir);
  assertDirectoryIfExists(dirname(path));
  const directory = new NativeDirectory(dirname(path));
  let quarantine: NativeDirectory | undefined;
  let captured: NodeIdentity | undefined;
  try {
    quarantine = new NativeDirectory(stateDir);
    const namedParent = lstatSync(dirname(path), { bigint: true });
    const namedState = lstatSync(stateDir, { bigint: true });
    if (
      String(namedParent.dev) !== directory.identity.dev ||
      String(namedParent.ino) !== directory.identity.ino ||
      String(namedState.dev) !== quarantine.identity.dev ||
      String(namedState.ino) !== quarantine.identity.ino
    )
      throw new Error("recovery parent changed; evidence retained");
    captured = directory.inspect(basename(path));
    if (!captured || captured.kind !== "file" || directory.hash(basename(path), captured, maxBytes) !== expectedHash)
      throw new Error("recovery evidence changed; nothing was discarded");
    const moved = dirname(path) !== stateDir || basename(path) !== stageName;
    if (moved) {
      directory.moveExclusive(basename(path), quarantine, stageName);
      directory.sync();
      quarantine.sync();
    }
    const staged = quarantine.inspect(stageName);
    if (
      !staged ||
      !sameNode(moved ? { ...staged, ctime: captured.ctime } : staged, captured) ||
      quarantine.hash(stageName, staged, maxBytes) !== expectedHash
    )
      throw new Error(`recovery substitution retained at ${join(stateDir, stageName)}`);
    quarantine.unlink(stageName, "file");
    quarantine.sync();
  } finally {
    directory.close();
    quarantine?.close();
  }
}

export function discardOriginal(log: OperationLog, id: string) {
  if (!currentOperationToken(log.stateDir)) throw new Error("original discard requires the store operation lease");
  const original = inspectOriginal(log, id);
  if (!original) throw new Error("original evidence was not found");
  if (!original.verified || !original.formatValid)
    throw new Error("original content address or format does not match; evidence retained for manual reconciliation");
  const stageName = `records.json.corrupt-discard-${id.replace(":", "-")}`;
  const decision = log.recordEvidenceDiscard(
    `explicit discard of ${id}; target files and active records unchanged; the original may remain if interrupted`,
    [original.path, join(log.stateDir, stageName)],
  );
  removeRecoveryFile(log.stateDir, original.path, id.split(":")[1]!, MAX_ORIGINAL_BYTES, stageName);
  return { ...original, discarded: true, decision: decision.id };
}

export function purgeDiscarded(log: OperationLog, id: string) {
  const operation = log.get(id);
  if (!operation || operation.stage !== "discarded") throw new Error("only an already-discarded receipt can be purged");
  log.removeDiscardedChunks(id);
  const path = join(log.directory, `${id}.json`);
  const bytes = readFileIfExists(path, 16 * 1024 * 1024);
  if (!bytes) throw new Error("discarded receipt was not found");
  const expected = log.get(id);
  if (JSON.stringify(expected) !== JSON.stringify(operation)) throw new Error("discarded receipt changed");
  if (!currentOperationToken(log.stateDir)) throw new Error("receipt purge requires the store operation lease");
  assertDirectoryIfExists(log.stateDir);
  assertDirectoryIfExists(log.directory);
  const directory = new NativeDirectory(log.directory);
  try {
    const named = lstatSync(log.directory, { bigint: true });
    if (String(named.dev) !== directory.identity.dev || String(named.ino) !== directory.identity.ino)
      throw new Error("receipt directory changed; evidence retained");
    const name = `${id}.json`;
    const node = directory.inspect(name);
    if (
      !node ||
      node.kind !== "file" ||
      directory.hash(name, node, 16 * 1024 * 1024) !== new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    )
      throw new Error("discarded receipt changed; evidence retained");
    // Keep the named, already-discarded receipt retriable if unlink fails. Moving it into a
    // corrupt quarantine would create an unaddressable graph and strand future blob GC.
    directory.unlink(name, "file");
    directory.sync();
  } finally {
    directory.close();
  }
  return { id, purged: true, retainedPaths: operation.retainedPaths ?? [] };
}
