import type { AbsolutePath, DeletedEntry, MutatedEntry, OwnedEntry, OwnedKind } from "../../types";
import type { BackupPolicy, NormalizationDiagnostic, NormalizeInput, NormalizedEffects } from "../capture/normalize";
import type { DirectoryMetadata, FileMetadata, NodeMetadata, RenameEvent, SymlinkMetadata } from "../capture/events";

/**
 * One filesystem node as normalization tracks it. Hashes and sizes are optional because a backend
 * can report a path it could not read (a heuristic fallback, an unreadable file, a bare rename).
 */
type NodeState = {
  kind: OwnedKind;
  hash?: string;
  size?: number;
  mode?: number;
  mtimeMs?: number;
  /** Symlink target, recorded rather than followed. */
  target?: AbsolutePath;
};

/** Accumulated state for one path across the journal; paths are keyed case-correctly (D10). */
type PathState = {
  /** Latest spelling of the path; preserved even when the key is case-folded. */
  path: AbsolutePath;
  /** `undefined` until pre-install existence is known; `null` means the path did not exist before. */
  initial: NodeState | null | undefined;
  /** State at the current point in the journal; `null` once the path is removed. */
  current: NodeState | null;
  /** Set when an install-created path is removed: a rename gives "rename", any other removal "delete". */
  removed?: "rename" | "delete";
  /** A change that carries no content hash (mode-only), tracked so it still reads as a mutation. */
  modeChanged: boolean;
};

/**
 * Pure conversion from an install journal to normalized effects (plan sections 1, 3, 4). It makes
 * no OS calls and reads no files: every hash and size comes from the events themselves.
 *
 * Rules the sequence is collapsed by:
 * - A temporary file created (or written) and renamed over a destination becomes a change to the
 *   destination; the transient source leaves no entry and is reported as a `temp-rename` diagnostic.
 * - A path created and then removed before the install ends cancels out (`create-delete`).
 * - An overwrite or deletion keeps the prior hash (and, when backups allow, the prior content
 *   address as `beforeBlob`) only when the events actually carried it.
 * - A rename is a source removal plus a destination creation/replacement; the relationship is
 *   retained in a `rename` diagnostic.
 * - Content equality is decided by hash first; mtime/size are only a fast path used when no hash is
 *   available, so a hash change with an unchanged mtime is still a mutation and unchanged content
 *   with noisy metadata is not.
 */
export function normalizeJournal(input: NormalizeInput): NormalizedEffects {
  const { journal, backups, caseSensitive } = input;
  const diagnostics: NormalizationDiagnostic[] = [];
  const states = new Map<string, PathState>();

  if (journal.completeness !== "complete") {
    diagnostics.push({
      code: "coverage",
      message: `capture completeness is ${journal.completeness}${journal.partialReason ? `: ${journal.partialReason}` : ""}`,
      paths: [],
    });
  }

  const keyFor = (path: AbsolutePath): string => (caseSensitive ? path : path.toLowerCase());

  const stateFor = (path: AbsolutePath): PathState => {
    const key = keyFor(path);
    const existing = states.get(key);
    if (existing) {
      existing.path = path;
      return existing;
    }
    const state: PathState = { path, initial: undefined, current: null, modeChanged: false };
    states.set(key, state);
    return state;
  };

  const handleRename = (event: RenameEvent): void => {
    const from = stateFor(event.from);
    if (from.initial === undefined) from.initial = event.before ? nodeFrom(event.before) : null;
    const sourceNode = event.before ? nodeFrom(event.before) : from.current;
    from.current = null;

    const to = stateFor(event.to);
    const destNode = event.after ? nodeFrom(event.after) : sourceNode;
    // The events do not say whether the destination pre-existed. Per the plan a rename is a
    // destination creation/replacement, so an unknown destination is treated as created.
    if (to.initial === undefined) to.initial = null;
    to.current = destNode ?? { kind: "unknown" };

    if (from.initial === null) {
      from.removed = "rename";
      diagnostics.push({
        code: "temp-rename",
        message: "a temporary path was renamed onto its destination",
        paths: [event.from, event.to],
      });
    } else {
      diagnostics.push({ code: "rename", message: "a path was renamed", paths: [event.from, event.to] });
    }
  };

  // The journal assigns `seq`; sorting defensively keeps normalization deterministic if a backend
  // ever hands events over out of order.
  const events = [...journal.events].sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    switch (event.type) {
      case "create": {
        const state = stateFor(event.path);
        if (state.initial === undefined) state.initial = null;
        state.current = nodeFrom(event.after);
        break;
      }
      case "mkdir": {
        const state = stateFor(event.path);
        if (state.initial === undefined) state.initial = null;
        state.current = directoryNode(event.after);
        break;
      }
      case "symlink": {
        const state = stateFor(event.path);
        if (state.initial === undefined) state.initial = null;
        state.current = symlinkNode(event.after);
        break;
      }
      case "write": {
        const state = stateFor(event.path);
        // A `before` is how a backend proves the file pre-existed; without one the path's prior
        // existence stays unknown until a rename or classification decides what to do with it.
        if (state.initial === undefined && event.before) state.initial = fileNode(event.before);
        state.current = fileNode(event.after);
        break;
      }
      case "chmod": {
        const state = stateFor(event.path);
        // `undefined` or a prior node both mean the path was not created by this install.
        const existedBefore = state.initial !== null;
        const prior = event.before?.mode ?? state.current?.mode;
        if (state.current) {
          state.current = { ...state.current, mode: event.after.mode };
        } else {
          if (state.initial === undefined) state.initial = { kind: "file", mode: event.after.mode };
          state.current = { kind: "file", mode: event.after.mode };
        }
        if (prior === undefined || prior !== event.after.mode) {
          state.modeChanged = true;
          if (existedBefore) {
            diagnostics.push({
              code: "unsupported",
              message: "a mode change is recorded but v3 cannot represent the mode for restore",
              paths: [event.path],
            });
          }
        }
        break;
      }
      case "unlink": {
        const state = stateFor(event.path);
        // A path we saw appear without proof it pre-existed (a lone write) is treated as created,
        // so write-then-delete cancels like create-then-delete; an unrecorded path is a deletion.
        if (state.initial === undefined) state.initial = state.current === null ? nodeFrom(event.before) : null;
        state.current = null;
        state.removed = "delete";
        break;
      }
      case "rmdir": {
        const state = stateFor(event.path);
        if (state.initial === undefined) {
          state.initial = state.current === null ? directoryNode(event.before) : null;
        }
        state.current = null;
        state.removed = "delete";
        break;
      }
      case "rename": {
        handleRename(event);
        break;
      }
    }
  }

  const owned: OwnedEntry[] = [];
  const mutated: MutatedEntry[] = [];
  const deleted: DeletedEntry[] = [];

  const sorted = [...states.values()].sort((a, b) => comparePaths(a.path, b.path));
  for (const state of sorted) {
    if (state.current !== null) {
      if (state.initial === null) {
        owned.push(ownedEntry(state.path, state.current));
      } else if (state.initial === undefined) {
        // Present with no proof it pre-existed (a lone write); record a non-restorable mutation
        // rather than claim ownership of a path that may have existed before the install.
        mutated.push(mutatedEntry(state.path, undefined, state.current, backups));
      } else if (changedFrom(state.initial, state.current, state.modeChanged)) {
        mutated.push(mutatedEntry(state.path, state.initial, state.current, backups));
      }
    } else if (state.initial === null) {
      if (state.removed !== "rename") {
        diagnostics.push({
          code: "create-delete",
          message: "a path was created and then removed by the install",
          paths: [state.path],
        });
      }
    } else if (state.initial !== undefined) {
      deleted.push(deletedEntry(state.path, state.initial, backups));
    }
  }

  return { owned, mutated, deleted, diagnostics };
}

/** Compares two absolute paths by code unit for a stable, locale-independent record order. */
function comparePaths(a: AbsolutePath, b: AbsolutePath): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fileNode(meta: FileMetadata): NodeState {
  return { kind: "file", hash: meta.hash, size: meta.size, mode: meta.mode, mtimeMs: meta.mtimeMs };
}

function directoryNode(meta: DirectoryMetadata): NodeState {
  return { kind: "directory", mode: meta.mode };
}

function symlinkNode(meta: SymlinkMetadata): NodeState {
  return { kind: "symlink", target: meta.target, mode: meta.mode };
}

function nodeFrom(meta: NodeMetadata): NodeState {
  switch (meta.kind) {
    case "file":
      return fileNode(meta);
    case "directory":
      return directoryNode(meta);
    case "symlink":
      return symlinkNode(meta);
  }
}

/** Whether a surviving pre-existing path changed, by kind, content, or mode. */
function changedFrom(before: NodeState, after: NodeState, modeChanged: boolean): boolean {
  if (modeChanged) return true;
  if (before.kind !== after.kind) return true;
  if (before.kind === "symlink") return before.target !== after.target;
  if (before.kind === "file") return !sameContent(before, after);
  return false;
}

/**
 * Content equality: hashes decide when both are known; otherwise mtime and size are a fast path
 * only. A missing hash on either side means equality cannot be proven, so the content counts as
 * changed (the caller records a mutation without claiming it is restorable).
 */
function sameContent(before: NodeState, after: NodeState): boolean {
  if (before.hash !== undefined && after.hash !== undefined) return before.hash === after.hash;
  if (before.hash !== undefined || after.hash !== undefined) return false;
  if (before.size === undefined || after.size === undefined) return false;
  if (before.size !== after.size) return false;
  if (before.mtimeMs !== undefined && after.mtimeMs !== undefined) return before.mtimeMs === after.mtimeMs;
  return false;
}

function ownedEntry(path: AbsolutePath, node: NodeState): OwnedEntry {
  const entry: OwnedEntry = { path, kind: node.kind };
  if (node.kind === "symlink") entry.linkTarget = node.target;
  if (node.hash !== undefined) entry.installedHash = node.hash;
  return entry;
}

function mutatedEntry(
  path: AbsolutePath,
  before: NodeState | undefined,
  after: NodeState,
  backups: BackupPolicy,
): MutatedEntry {
  const entry: MutatedEntry = { path };
  if (before?.hash !== undefined) entry.beforeHash = before.hash;
  if (after.hash !== undefined) entry.installedHash = after.hash;
  const blob = beforeImage(before, backups);
  if (blob !== undefined) entry.beforeBlob = blob;
  return entry;
}

function deletedEntry(path: AbsolutePath, before: NodeState, backups: BackupPolicy): DeletedEntry {
  const entry: DeletedEntry = { path };
  if (before.hash !== undefined) entry.beforeHash = before.hash;
  const blob = beforeImage(before, backups);
  if (blob !== undefined) entry.beforeBlob = blob;
  return entry;
}

/**
 * The content address of a before-image, or undefined when it cannot be claimed restorable. The
 * blob id is the sha256 of the content, so a known in-limit hash doubles as its address; storage
 * owns the bytes and the uninstall planner refuses a `beforeBlob` whose blob is missing.
 */
function beforeImage(before: NodeState | undefined, backups: BackupPolicy): string | undefined {
  if (!backups.enabled || before === undefined) return undefined;
  if (before.hash === undefined || before.size === undefined) return undefined;
  if (before.size > backups.sizeLimitBytes) return undefined;
  return before.hash;
}
