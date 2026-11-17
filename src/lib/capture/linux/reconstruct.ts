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
import { basename, dirname } from "node:path";
import { hasExcludedAncestor, inRoots, normalizeAbsolutePath } from "./paths";
import type { CaptureBudget } from "../budget";
import type { TracerResult } from "./raw";
import { privateStateFilter } from "../self-state";

/**
 * Turns tracer records into journal events. It runs after the window closes and inspects the final
 * filesystem state for created/modified paths, so metadata is best-effort rather than a per-event
 * snapshot: a path that existed but no longer does (a temp file, a deleted file, a rename source)
 * falls back to existence/kind from the baseline manifest. This is deliberate; the Linux tracer
 * seam gives order and identity, and content hashes are only ever claimed when the bytes were read.
 *
 * Every path's parent is resolved through symlinks before it is inspected or
 * recorded: a traced path that leaves the observe roots (through `..` after a symlinked component,
 * or a symlinked parent pointing outside) is dropped and the journal reports reduced coverage.
 */

export type ReconstructInput = {
  /** Prefixes preserve live-kind/order state while avoiding repeated content hashing. */
  state?: ReconstructState;
  metadataOnly?: boolean;
  budget?: CaptureBudget;
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
export type ReconstructState = { live: Map<AbsolutePath, LiveKind>; nextSequence: number };

export async function reconstruct(input: ReconstructInput): Promise<ReconstructResult> {
  const { traced, inspector: sourceInspector, baseline, roots, fallbackAt } = input;
  const events: JournalEvent[] = [];
  const diagnostics: string[] = [];
  const note = (message: string): void => {
    const bounded = message.slice(0, 1024);
    if (diagnostics.includes(bounded)) return;
    if (diagnostics.length < 32) diagnostics.push(bounded);
    else if (diagnostics.length === 32) diagnostics.push("additional reconstruction diagnostics omitted");
  };
  const privatePath = privateStateFilter();
  const excluded = (path: string) => privatePath(path) || inRoots(path, traced.excludedRoots ?? []);
  const inspector: FsInspector = {
    resolve: (path) => sourceInspector.resolve(path),
    inspect: async (path, options) => {
      input.budget?.inspect(path);
      const info = await sourceInspector.inspect(path, input.metadataOnly ? { hash: false } : options);
      if (info.kind === "unknown") note(`${path}: ${info.reason}`);
      return input.metadataOnly && info.kind === "file" ? { ...info, hash: undefined } : info;
    },
  };
  const live = input.state?.live ?? new Map<AbsolutePath, LiveKind>();
  const resolved = new Map<AbsolutePath, AbsolutePath>();
  let seq = input.state?.nextSequence ?? 0;

  const ordered = traced.records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const at = a.record.at - b.record.at;
      return at !== 0 ? at : a.index - b.index;
    });

  const push = (event: JournalEventInput & { at?: number }): void => {
    const { at: rawAt, ...rest } = event;
    const observed = { ...rest, seq: seq++, at: rawAt ?? fallbackAt + seq } as JournalEvent;
    input.budget?.event(observed);
    events.push(observed);
    if (input.state) input.state.nextSequence = seq;
  };

  // Roots are resolved once, so a symlinked ancestor (for example `/var` -> `/private/var` on a
  // test host) cannot make every in-root path read as an escape.
  const resolvedRoots: { root: AbsolutePath; resolved: AbsolutePath }[] = [];
  for (const root of roots) {
    input.budget?.check();
    try {
      resolvedRoots.push({ root, resolved: await resolveCached(inspector, root, resolved) });
    } catch {
      note(`observe root could not be resolved: ${root}`);
    }
  }
  resolvedRoots.sort((a, b) => b.resolved.length - a.resolved.length);

  for (const { record } of ordered) {
    input.budget?.check();
    if (record.op === "unsupported") {
      note(`unsupported syscall ${record.syscall}: ${record.reason}`);
      continue;
    }

    if (record.op === "rename") {
      const fromCheck = await checkPaths([record.from], inspector, roots, resolvedRoots, resolved, excluded);
      const toCheck = await checkPaths([record.to], inspector, roots, resolvedRoots, resolved, excluded);
      const from = fromCheck.kind === "ok" ? fromCheck.paths[0] : undefined;
      const to = toCheck.kind === "ok" ? toCheck.paths[0] : undefined;
      if (!from && !to) {
        if ([fromCheck, toCheck].some(check => check.kind === "escaped" || check.kind === "unresolved"))
          note("rename endpoints could not be safely resolved inside the observe roots");
        continue;
      }
      const before = from ? baselineNode(baseline, from) : undefined;
      const destinationBefore = to ? baselineNode(baseline, to) : undefined;
      const sourceAfter = from ? await sampledNode(inspector, from) : undefined;
      const after = to ? await sampledNode(inspector, to) : undefined;
      const directory = [before, destinationBefore, sourceAfter, after].some(node => node?.kind === "directory");
      const selfRename = from !== undefined && from === to && record.semantics !== "uncertain";
      const uncertain = !selfRename && (!from || !to || record.semantics === "uncertain" || directory ||
        (record.semantics !== "exchange" && sourceAfter !== null));
      if (uncertain || record.semantics === "exchange") {
        if (uncertain) note(directory ? "directory rename lineage is uncertain; known descendants require reconciliation" :
          from && to && record.semantics === undefined && sourceAfter !== null ?
            "ordinary rename source still exists at sampling; no source removal is inferred" :
            "rename has unsupported semantics or crosses an observation boundary; only included endpoints are retained");
        push({ type: "rename", from: from ?? record.from, to: to ?? record.to,
          semantics: uncertain ? "uncertain" : "exchange",
          ...(!from ? { inScope: "to" as const } : !to ? { inScope: "from" as const } : {}),
          before, destinationBefore, sourceAfter, after, pid: record.pid, at: record.at });
        if (from) live.set(from, "existing");
        if (to) live.set(to, "existing");
      } else {
        const wasCreated = live.get(from!) === "created";
        push({ type: "rename", from: from!, to: to!,
          before: before ?? (wasCreated ? undefined : { kind: "unknown" }), after,
          destinationBefore: destinationBefore ?? (record.noReplace && !existedBefore(to!, baseline, live) ? null : undefined),
          pid: record.pid, at: record.at });
        live.delete(from!);
        live.set(to!, wasCreated ? "created" : "existing");
      }
      continue;
    }

    const check = await checkPaths([record.path], inspector, roots, resolvedRoots, resolved, excluded);
    if (check.kind === "out-of-scope") continue;
    if (check.kind === "escaped") {
      note(`a traced path was dropped because it does not stay inside the observe roots: ${check.path}`);
      continue;
    }
    if (check.kind === "unresolved") {
      note(`a traced parent could not be safely resolved: ${check.path}`);
      continue;
    }
    const target = { ...record, path: check.paths[0]! };

    switch (target.op) {
      case "open": {
        const existed = existedBefore(target.path, baseline, live);
        const after = await fileAfter(inspector, target.path);
        if (target.created && target.exclusive && !existed) {
          live.set(target.path, "created");
          push({ type: "create", path: target.path, after, pid: target.pid, at: target.at });
        } else if (target.truncated || target.created) {
          live.set(target.path, "existing");
          const before = existed ? baselineFile(baseline, target.path) : undefined;
          push({ type: "write", path: target.path, before, after, pid: target.pid, at: target.at });
        } else if (existed) {
          live.set(target.path, "existing");
        }
        break;
      }
      case "write": {
        // A write with no preceding create is either an overwrite or a create we never saw. With a
        // captured baseline (backups enabled) the pre-window metadata proves which and supplies the
        // `before` a restore needs; without one, normalize decides from what the sequence proves.
        const wasCreated = live.get(target.path) === "created";
        live.set(target.path, wasCreated ? "created" : "existing");
        const before = wasCreated ? undefined : baselineFile(baseline, target.path);
        push({
          type: "write",
          path: target.path,
          before,
          after: await fileAfter(inspector, target.path),
          pid: target.pid,
          at: target.at,
        });
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
  | { kind: "unresolved"; path: AbsolutePath }
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
  resolvedRoots: { root: AbsolutePath; resolved: AbsolutePath }[],
  cache: Map<AbsolutePath, AbsolutePath>,
  excluded: (path: string) => boolean,
): Promise<PathCheck> {
  const normalizedPaths: AbsolutePath[] = [];
  for (const raw of paths) {
    const normalized = normalizeAbsolutePath(raw);
    if (normalized === undefined || !inRoots(normalized, roots)) return { kind: "out-of-scope" };
    if (hasExcludedAncestor(normalized)) return { kind: "out-of-scope" };
    // The observe-root node itself is an object even when its final component is a symlink.
    if (raw === normalized && roots.includes(raw) && !excluded(raw)) {
      normalizedPaths.push(raw);
      continue;
    }
    let candidate: AbsolutePath | undefined;
    try {
      const parent = await resolveCached(inspector, dirname(raw), cache);
      candidate = normalizeAbsolutePath(`${parent}/${basename(raw)}`);
    } catch {
      return { kind: "unresolved", path: raw };
    }
    if (candidate === undefined) return { kind: "unresolved", path: raw };
    const alias = resolvedRoots.find(({ resolved }) => inRoots(candidate!, [resolved]));
    if (!alias) return { kind: "escaped", path: raw };
    if (hasExcludedAncestor(candidate) || excluded(candidate)) return { kind: "out-of-scope" };
    // Preserve the baseline's root spelling (/var versus /private/var), but never the raw
    // symlink/.. suffix: inspecting that lexical suffix could fingerprint an unrelated object.
    const suffix = alias.resolved === "/" ? candidate : candidate.slice(alias.resolved.length);
    normalizedPaths.push(normalizeAbsolutePath(`${alias.root}/${suffix}`)!);
  }
  return { kind: "ok", paths: normalizedPaths };
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

function existedBefore(path: AbsolutePath, baseline: Baseline, live: Map<AbsolutePath, LiveKind>): boolean {
  const state = live.get(path);
  if (state !== undefined) return state === "existing";
  return baseline.existed(path);
}

/** Prior facts only: final contents of a rename source can belong to the other endpoint. */
function baselineNode(baseline: Baseline, path: AbsolutePath): NodeMetadata | undefined {
  const captured = baseline.metadata(path);
  if (captured) return nodeMetadata(captured) ?? { kind: "unknown" };
  const kind = baseline.kind(path);
  if (kind === "file" || kind === "directory") return { kind };
  return baseline.existed(path) ? { kind: "unknown" } : undefined;
}

async function sampledNode(inspector: FsInspector, path: AbsolutePath): Promise<NodeMetadata | null> {
  const info = await inspector.inspect(path);
  return info.kind === "missing" ? null : nodeMetadata(info) ?? { kind: "unknown" };
}

/** Final metadata for a file, or a kind-only fallback when the path is gone. */
async function fileAfter(inspector: FsInspector, path: AbsolutePath): Promise<FileMetadata> {
  const info = await inspector.inspect(path);
  if (info.kind !== "file") return { kind: "file" };
  return fileMetadata(info);
}

/** The journal metadata for an inspected node; `missing` has none. */
function nodeMetadata(info: NodeInfo): NodeMetadata | undefined {
  switch (info.kind) {
    case "file":
      return fileMetadata(info);
    case "directory":
      return { kind: "directory", mode: info.mode } satisfies DirectoryMetadata;
    case "symlink":
      return { kind: "symlink", target: info.target, mode: info.mode } satisfies SymlinkMetadata;
    case "missing":
    case "unknown":
      return undefined;
  }
}

/** The baseline's captured pre-window metadata for a file, when backups captured it. */
function baselineFile(baseline: Baseline, path: AbsolutePath): FileMetadata | undefined {
  const info = baseline.metadata(path);
  return info === undefined || info.kind !== "file" ? undefined : fileMetadata(info);
}

/**
 * The before-state of a removal or rename source: the pre-window metadata the baseline captured
 * (backups enabled) when the path was not created in this window, else the current node when one
 * still exists, else the baseline kind (or a file fallback) so a temporary path still collapses.
 */
async function beforeNode(
  inspector: FsInspector,
  path: AbsolutePath,
  baseline: Baseline,
  live: Map<AbsolutePath, LiveKind>,
): Promise<NodeMetadata> {
  const created = live.get(path) === "created";
  const captured = created ? undefined : baseline.metadata(path);
  const capturedNode = captured === undefined ? undefined : nodeMetadata(captured);
  if (capturedNode !== undefined) return capturedNode;
  const current = nodeMetadata(await inspector.inspect(path));
  if (current !== undefined) return current;
  const kind = created ? inferredKind(path, baseline) : (baseline.kind(path) ?? inferredKind(path, baseline));
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
