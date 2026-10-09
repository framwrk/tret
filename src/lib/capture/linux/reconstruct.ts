import type { AbsolutePath, OwnedKind } from "../../../types";
import type { Baseline, FsInspector, NodeInfo } from "./inspect";
import type {
  DirectoryMetadata,
  FileMetadata,
  JournalEvent,
  JournalEventInput,
  NodeMetadata,
  SymlinkMetadata,
} from "../events";
import type { TracerRecord, TracerResult } from "./raw";
import { inRoots } from "./strace";

/**
 * Turns tracer records into journal events. It runs after the window closes and inspects the final
 * filesystem state for created/modified paths, so metadata is best-effort rather than a per-event
 * snapshot: a path that existed but no longer does (a temp file, a deleted file, a rename source)
 * falls back to existence/kind from the baseline manifest. This is deliberate; the Linux tracer
 * seam gives order and identity, and content hashes are only ever claimed when the bytes were read.
 */

export type ReconstructInput = {
  traced: TracerResult;
  inspector: FsInspector;
  /** Existence/kind baseline used to tell a create from an overwrite. */
  baseline: Baseline;
  /** Observe roots; records outside them are dropped (defense in depth over parser filtering). */
  roots: AbsolutePath[];
  /** Wall-clock time used for records whose tracer did not report one. */
  fallbackAt: number;
};

export type ReconstructResult = {
  events: JournalEvent[];
  /** Non-fatal notes (unsupported syscalls, unresolved paths) surfaced in coverage docs/tests. */
  diagnostics: string[];
};

type LiveKind = "created" | "existing";

export async function reconstruct(input: ReconstructInput): Promise<ReconstructResult> {
  const { traced, inspector, baseline, roots, fallbackAt } = input;
  const events: JournalEvent[] = [];
  const diagnostics: string[] = [];
  const live = new Map<AbsolutePath, LiveKind>();
  let seq = 0;

  const ordered = traced.records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const at = a.record.at - b.record.at;
      return at !== 0 ? at : a.index - b.index;
    });

  const push = (event: JournalEventInput & { at?: number }): void => {
    const { at: rawAt, ...rest } = event;
    events.push({ ...rest, seq: seq++, at: rawAt ?? fallbackAt + seq } as JournalEvent);
  };

  for (const { record } of ordered) {
    if (record.op === "unsupported") {
      diagnostics.push(`unsupported syscall ${record.syscall}: ${record.reason}`);
      continue;
    }
    const paths = pathsOf(record);
    if (!paths.every((path) => inRoots(path, roots))) continue;

    switch (record.op) {
      case "open": {
        const existed = existedBefore(record.path, baseline, live);
        const after = await fileAfter(inspector, record.path);
        if (record.created && !existed) {
          live.set(record.path, "created");
          push({ type: "create", path: record.path, after, pid: record.pid, at: record.at });
        } else if (record.truncated) {
          live.set(record.path, "existing");
          push({ type: "write", path: record.path, after, pid: record.pid, at: record.at });
        } else if (existed) {
          live.set(record.path, "existing");
        }
        break;
      }
      case "write": {
        // A write with no preceding create is either an overwrite or a create we never saw;
        // normalize decides using the baseline metadata we cannot provide here.
        live.set(record.path, live.get(record.path) === "created" ? "created" : "existing");
        push({
          type: "write",
          path: record.path,
          after: await fileAfter(inspector, record.path),
          pid: record.pid,
          at: record.at,
        });
        break;
      }
      case "rename": {
        const before = await beforeNode(inspector, record.from, baseline, live);
        const after = await genericAfter(inspector, record.to);
        const wasCreated = live.get(record.from) === "created";
        live.delete(record.from);
        live.set(record.to, wasCreated ? "created" : "existing");
        push({ type: "rename", from: record.from, to: record.to, before, after, pid: record.pid, at: record.at });
        break;
      }
      case "unlink": {
        const before = await beforeNode(inspector, record.path, baseline, live);
        live.delete(record.path);
        push({ type: "unlink", path: record.path, before, pid: record.pid, at: record.at });
        break;
      }
      case "rmdir": {
        live.delete(record.path);
        push({ type: "rmdir", path: record.path, before: { kind: "directory" }, pid: record.pid, at: record.at });
        break;
      }
      case "chmod": {
        push({ type: "chmod", path: record.path, after: { mode: record.mode }, pid: record.pid, at: record.at });
        break;
      }
      case "symlink": {
        const info = await inspector.inspect(record.path);
        const after: SymlinkMetadata =
          info.kind === "symlink"
            ? { kind: "symlink", target: info.target, mode: info.mode }
            : { kind: "symlink", target: record.target };
        live.set(record.path, "created");
        push({ type: "symlink", path: record.path, target: record.target, after, pid: record.pid, at: record.at });
        break;
      }
      case "mkdir": {
        const info = await inspector.inspect(record.path);
        const after: DirectoryMetadata =
          info.kind === "directory" ? { kind: "directory", mode: info.mode } : { kind: "directory" };
        live.set(record.path, "created");
        push({ type: "mkdir", path: record.path, after, pid: record.pid, at: record.at });
        break;
      }
    }
  }

  return { events, diagnostics };
}

function pathsOf(record: TracerRecord): AbsolutePath[] {
  switch (record.op) {
    case "rename":
      return [record.from, record.to];
    case "unsupported":
      return record.path === undefined ? [] : [record.path];
    default:
      return [record.path];
  }
}

function existedBefore(path: AbsolutePath, baseline: Baseline, live: Map<AbsolutePath, LiveKind>): boolean {
  const state = live.get(path);
  if (state !== undefined) return state === "existing";
  return baseline.existed(path);
}

/** Final metadata for a file, or a kind-only fallback when the path is gone. */
async function fileAfter(inspector: FsInspector, path: AbsolutePath): Promise<FileMetadata> {
  const info = await inspector.inspect(path);
  if (info.kind !== "file") return { kind: "file" };
  return fileMetadata(info);
}

/** Final metadata for any node, or a kind-only fallback when the path is gone. */
async function genericAfter(inspector: FsInspector, path: AbsolutePath): Promise<NodeMetadata | undefined> {
  const info = await inspector.inspect(path);
  switch (info.kind) {
    case "file":
      return fileMetadata(info);
    case "directory":
      return { kind: "directory", mode: info.mode } satisfies DirectoryMetadata;
    case "symlink":
      return { kind: "symlink", target: info.target, mode: info.mode } satisfies SymlinkMetadata;
    case "missing":
      return undefined;
  }
}

/** Best-effort before-state: baseline kind when the path is gone, else the current node. */
async function beforeNode(
  inspector: FsInspector,
  path: AbsolutePath,
  baseline: Baseline,
  live: Map<AbsolutePath, LiveKind>,
): Promise<NodeMetadata> {
  const info = await inspector.inspect(path);
  if (info.kind !== "missing") return genericAfter(inspector, path) as Promise<NodeMetadata>;
  const kind =
    live.get(path) === "created" ? inferredKind(path, baseline) : (baseline.kind(path) ?? inferredKind(path, baseline));
  return kindOnly(kind);
}

function inferredKind(path: AbsolutePath, baseline: Baseline): OwnedKind {
  return baseline.kind(path) ?? "file";
}

function kindOnly(kind: OwnedKind): NodeMetadata {
  switch (kind) {
    case "directory":
      return { kind: "directory" };
    case "symlink":
      return { kind: "symlink", target: "" };
    case "file":
    case "unknown":
      return { kind: "file" };
  }
}

function fileMetadata(info: Extract<NodeInfo, { kind: "file" }>): FileMetadata {
  const metadata: FileMetadata = { kind: "file" };
  if (info.hash !== undefined) metadata.hash = info.hash;
  if (info.size !== undefined) metadata.size = info.size;
  if (info.mode !== undefined) metadata.mode = info.mode;
  if (info.mtimeMs !== undefined) metadata.mtimeMs = info.mtimeMs;
  return metadata;
}
