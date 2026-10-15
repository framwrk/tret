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
import { basename, dirname } from "node:path";
import { inRoots, normalizeAbsolutePath } from "./paths";

/**
 * Turns tracer records into journal events. It runs after the window closes and inspects the final
 * filesystem state for created/modified paths, so metadata is best-effort rather than a per-event
 * snapshot: a path that existed but no longer does (a temp file, a deleted file, a rename source)
 * falls back to existence/kind from the baseline manifest. This is deliberate; the Linux tracer
 * seam gives order and identity, and content hashes are only ever claimed when the bytes were read.
 *
 * Every path is lexically normalized and its parent resolved through symlinks before it is
 * recorded: a traced path that leaves the observe roots (through `..` after a symlinked component,
 * or a symlinked parent pointing outside) is dropped and the journal reports reduced coverage.
 */

export type ReconstructInput = {
  traced: TracerResult;
  inspector: FsInspector;
  /** Existence/kind baseline used to tell a create from an overwrite. */
  baseline: Baseline;
  /**
   * Observe roots; records outside them are dropped (defense in depth over parser filtering). A
   * path that is lexically inside a root but resolves outside it — through a symlinked component —
   * is dropped with a diagnostic, because the record must never claim an object outside the roots.
   */
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
  const resolved = new Map<AbsolutePath, AbsolutePath>();
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

  // Roots are resolved once, so a symlinked ancestor (for example `/var` -> `/private/var` on a
  // test host) cannot make every in-root path read as an escape.
  const resolvedRoots =
    roots.length === 0 ? [] : await Promise.all(roots.map((root) => resolveCached(inspector, root, resolved)));

  for (const { record } of ordered) {
    if (record.op === "unsupported") {
      diagnostics.push(`unsupported syscall ${record.syscall}: ${record.reason}`);
      continue;
    }

    const check = await checkPaths(pathsOf(record), inspector, roots, resolvedRoots, resolved);
    if (check.kind === "out-of-scope") continue;
    if (check.kind === "escaped") {
      diagnostics.push(`a traced path was dropped because it does not stay inside the observe roots: ${check.path}`);
      continue;
    }
    const target = withNormalizedPaths(record, check.paths);

    switch (target.op) {
      case "open": {
        const existed = existedBefore(target.path, baseline, live);
        const after = await fileAfter(inspector, target.path);
        if (target.created && !existed) {
          live.set(target.path, "created");
          push({ type: "create", path: target.path, after, pid: target.pid, at: target.at });
        } else if (target.truncated) {
          live.set(target.path, "existing");
          push({ type: "write", path: target.path, after, pid: target.pid, at: target.at });
        } else if (existed) {
          live.set(target.path, "existing");
        }
        break;
      }
      case "write": {
        // A write with no preceding create is either an overwrite or a create we never saw;
        // normalize decides using the baseline metadata we cannot provide here.
        live.set(target.path, live.get(target.path) === "created" ? "created" : "existing");
        push({
          type: "write",
          path: target.path,
          after: await fileAfter(inspector, target.path),
          pid: target.pid,
          at: target.at,
        });
        break;
      }
      case "rename": {
        const before = await beforeNode(inspector, target.from, baseline, live);
        const after = await genericAfter(inspector, target.to);
        const wasCreated = live.get(target.from) === "created";
        live.delete(target.from);
        live.set(target.to, wasCreated ? "created" : "existing");
        push({ type: "rename", from: target.from, to: target.to, before, after, pid: target.pid, at: target.at });
        break;
      }
      case "unlink": {
        const before = await beforeNode(inspector, target.path, baseline, live);
        live.delete(target.path);
        push({ type: "unlink", path: target.path, before, pid: target.pid, at: target.at });
        break;
      }
      case "rmdir": {
        live.delete(target.path);
        push({ type: "rmdir", path: target.path, before: { kind: "directory" }, pid: target.pid, at: target.at });
        break;
      }
      case "chmod": {
        push({ type: "chmod", path: target.path, after: { mode: target.mode }, pid: target.pid, at: target.at });
        break;
      }
      case "symlink": {
        const info = await inspector.inspect(target.path);
        const after: SymlinkMetadata =
          info.kind === "symlink"
            ? { kind: "symlink", target: info.target, mode: info.mode }
            : { kind: "symlink", target: target.target };
        live.set(target.path, "created");
        push({ type: "symlink", path: target.path, target: target.target, after, pid: target.pid, at: target.at });
        break;
      }
      case "mkdir": {
        const info = await inspector.inspect(target.path);
        const after: DirectoryMetadata =
          info.kind === "directory" ? { kind: "directory", mode: info.mode } : { kind: "directory" };
        live.set(target.path, "created");
        push({ type: "mkdir", path: target.path, after, pid: target.pid, at: target.at });
        break;
      }
    }
  }

  return { events, diagnostics };
}

/** What the path check decided for one tracer record: record it, drop it silently, or report it. */
type PathCheck =
  | { kind: "ok"; paths: AbsolutePath[] }
  /** Lexically outside every observe root: normal out-of-scope filtering, never reported. */
  | { kind: "out-of-scope" }
  /** Lexically inside a root but truly outside it once symlinks are resolved: a coverage loss. */
  | { kind: "escaped"; path: AbsolutePath };

/**
 * Normalizes every path in a record and checks that the object it names really sits inside the
 * observe roots. The parent directory is resolved through symlinks — the final component
 * deliberately is not followed, because removing a symlink inside the roots never touches its
 * target — and the remaining name is rejoined before the root check. That makes a `..` after a
 * symlinked component resolve the way the kernel resolved it, which a lexical prefix match cannot.
 */
async function checkPaths(
  paths: AbsolutePath[],
  inspector: FsInspector,
  roots: AbsolutePath[],
  resolvedRoots: AbsolutePath[],
  cache: Map<AbsolutePath, AbsolutePath>,
): Promise<PathCheck> {
  const normalizedPaths: AbsolutePath[] = [];
  for (const raw of paths) {
    const normalized = normalizeAbsolutePath(raw);
    if (normalized === undefined || !inRoots(normalized, roots)) return { kind: "out-of-scope" };
    if (await escapesResolvedRoots(raw, normalized, inspector, roots, resolvedRoots, cache)) {
      return { kind: "escaped", path: raw };
    }
    normalizedPaths.push(normalized);
  }
  return { kind: "ok", paths: normalizedPaths };
}

/** Whether `raw` resolves outside every observe root once its parent's symlinks are followed. */
async function escapesResolvedRoots(
  raw: AbsolutePath,
  normalized: AbsolutePath,
  inspector: FsInspector,
  roots: AbsolutePath[],
  resolvedRoots: AbsolutePath[],
  cache: Map<AbsolutePath, AbsolutePath>,
): Promise<boolean> {
  // A path that is itself a root is inside by definition; its parent sits above the roots.
  if (roots.some((root) => root === normalized)) return false;
  const resolvedParent = await resolveCached(inspector, dirname(raw), cache);
  const candidate = normalizeAbsolutePath(`${resolvedParent}/${basename(raw)}`);
  return candidate === undefined || !inRoots(candidate, resolvedRoots);
}

/** Resolves a path once and memoizes by path; many tracer records share a parent directory. */
async function resolveCached(
  inspector: FsInspector,
  path: AbsolutePath,
  cache: Map<AbsolutePath, AbsolutePath>,
): Promise<AbsolutePath> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const resolved = await inspector.resolve(path);
  cache.set(path, resolved);
  return resolved;
}

/** A copy of the record with its paths replaced by their normalized forms. */
function withNormalizedPaths(
  record: Exclude<TracerRecord, { op: "unsupported" }>,
  paths: AbsolutePath[],
): Exclude<TracerRecord, { op: "unsupported" }> {
  if (record.op === "rename") {
    const [from, to] = paths;
    return from !== undefined && to !== undefined ? { ...record, from, to } : record;
  }
  const [path] = paths;
  return path !== undefined ? { ...record, path } : record;
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
