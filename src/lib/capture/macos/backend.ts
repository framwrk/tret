import type { AbsolutePath, CaptureCompleteness } from "../../../types";
import type { CaptureBackend, CaptureSession, CaptureStartOptions } from "../backend";
import type { Journal, JournalEvent, JournalEventInput } from "../events";
import { diffScopedSnapshots, filesToHash, hashFile, scanScopedRoots, scopedPathKey } from "./scoped";
import { MACOS_PLATFORM } from "../../platform";
import type { ScopedSnapshot } from "./scoped";

/** Identifier stored in `record.capture.backend` for the macOS heuristic fallback (D1). */
export const MACOS_HEURISTIC_BACKEND = "macos-heuristic";

export type MacosHeuristicOptions = {
  /** Path comparison case sensitivity; defaults to the macOS platform table (D10). */
  caseSensitive?: boolean;
  /** Scope roots used when `start` is called with none; mainly for tests. */
  roots?: AbsolutePath[];
  /** Content hash function; injected in tests for determinism. Defaults to sha256. */
  hash?: (path: AbsolutePath) => Promise<string | undefined>;
};

/**
 * The macOS capture backend (D1). No unprivileged macOS mechanism attributes filesystem changes to
 * a process tree (EndpointSecurity needs an Apple entitlement and root; DTrace/`fs_usage` need root
 * and SIP relaxation; FSEvents and DYLD injection have other blind spots), so this backend does not
 * claim attribution. It takes scoped snapshots of the platform table's roots before and after the
 * install window, hashes files whose stamps changed, and reports `completeness: "heuristic"`. It
 * requires no root and no Apple entitlement, and it still produces the same `CaptureBackend` journal
 * a future opt-in tracer would. See `docs/rewrite/macos-capture.md` for the coverage limits.
 */
export class MacosHeuristicCaptureBackend implements CaptureBackend {
  readonly name = MACOS_HEURISTIC_BACKEND;
  readonly completeness: CaptureCompleteness = "heuristic";
  /** Exposed so callers and tests can see which case behavior the fallback compares with (D10). */
  readonly caseSensitive: boolean;
  private readonly roots?: AbsolutePath[];
  private readonly hash: (path: AbsolutePath) => Promise<string | undefined>;

  constructor(options: MacosHeuristicOptions = {}) {
    this.caseSensitive = options.caseSensitive ?? MACOS_PLATFORM.case.defaultCaseSensitive;
    this.roots = options.roots;
    this.hash = options.hash ?? hashFile;
  }

  async start(options: CaptureStartOptions): Promise<CaptureSession> {
    const roots = options.roots.length > 0 ? options.roots : (this.roots ?? []);
    const caseSensitive = this.caseSensitive;
    const before: ScopedSnapshot | undefined = roots.length > 0 ? scanScopedRoots(roots, { caseSensitive }) : undefined;

    return {
      backend: this.name,
      stop: async (): Promise<Journal> => {
        if (before === undefined) {
          return {
            backend: this.name,
            completeness: "heuristic",
            partialReason: "no scope roots to observe",
            events: [],
          };
        }

        const after = scanScopedRoots(roots, { caseSensitive });
        const hashErrors: AbsolutePath[] = [];
        for (const path of filesToHash(before, after)) {
          const hash = await this.hash(path);
          const node = after.entries.get(scopedPathKey(path, caseSensitive));
          if (hash === undefined) hashErrors.push(path);
          else if (node) node.hash = hash;
        }

        const events: JournalEventInput[] = diffScopedSnapshots(before, after);
        const partialReason = this.partialReason([...new Set([...before.errors, ...after.errors])], hashErrors);
        return {
          backend: this.name,
          completeness: "heuristic",
          ...(partialReason === undefined ? {} : { partialReason }),
          events: events.map((event, seq) => ({ ...event, seq, at: Date.now() }) as JournalEvent),
        };
      },
    };
  }

  private partialReason(scanErrors: string[], hashErrors: AbsolutePath[]): string | undefined {
    const reasons: string[] = [];
    if (scanErrors.length > 0) reasons.push(`some scope roots could not be scanned: ${scanErrors.join("; ")}`);
    if (hashErrors.length > 0) reasons.push(`some files could not be hashed: ${hashErrors.join(", ")}`);
    return reasons.length > 0 ? reasons.join("; ") : undefined;
  }
}
