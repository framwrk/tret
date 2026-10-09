import type { AbsolutePath, CaptureCompleteness } from "../../../types";
import type { CaptureBackend, CaptureSession, CaptureStartOptions } from "../backend";
import type { Journal, JournalEvent, JournalEventInput } from "../events";
import { diffScopedSnapshots, filesToHash, hashBytes, hashFile, readFileBytes, scanScopedRoots, scopedPathKey } from "./scoped";
import { MACOS_PLATFORM } from "../../platform";
import type { ScopedRootBounds } from "./scoped";
import type { ScopedSnapshot } from "./scoped";
import { isVolatileChurnPath } from "./scope";
import { macosHomeRootBounds } from "./homeScope";

/** Identifier stored in `record.capture.backend` for the macOS heuristic fallback (D1). */
export const MACOS_HEURISTIC_BACKEND = "macos-heuristic";

export type MacosHeuristicOptions = {
  /** Path comparison case sensitivity; defaults to the macOS platform table (D10). */
  caseSensitive?: boolean;
  /** Scope roots used when `start` is called with none; mainly for tests. */
  roots?: AbsolutePath[];
  /** Content hash function; injected in tests for determinism. Defaults to sha256. */
  hash?: (path: AbsolutePath) => Promise<string | undefined>;
  /** Reads a file's bytes for a before-image; injected in tests to simulate an unreadable file. */
  read?: (path: AbsolutePath) => Promise<Uint8Array | undefined>;
  /**
   * Home directory whose top level is bounded when it appears in the observed roots; defaults to
   * `$HOME`. Mostly for tests, which scope a temp directory and pass it here.
   */
  home?: string;
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
  private readonly read: (path: AbsolutePath) => Promise<Uint8Array | undefined>;
  private readonly home?: string;

  constructor(options: MacosHeuristicOptions = {}) {
    this.caseSensitive = options.caseSensitive ?? MACOS_PLATFORM.case.defaultCaseSensitive;
    this.roots = options.roots;
    this.hash = options.hash ?? hashFile;
    this.read = options.read ?? readFileBytes;
    this.home = options.home ?? Bun.env.HOME;
  }

  async start(options: CaptureStartOptions): Promise<CaptureSession> {
    const roots = options.roots.length > 0 ? options.roots : (this.roots ?? []);
    const caseSensitive = this.caseSensitive;
    const rootBounds = this.homeRootBounds(roots);
    const before: ScopedSnapshot | undefined =
      roots.length > 0 ? scanScopedRoots(roots, { caseSensitive, skip: isVolatileChurnPath, rootBounds }) : undefined;
    // When backups are enabled the start snapshot keeps each pre-existing file's bytes (within the
    // size limit) alongside its hash, so an overwrite or deletion later still has something to
    // restore. This is the one place content is read before the installer runs; off by default (D2).
    const beforeImages = before === undefined ? new Map<string, Uint8Array>() : await this.captureBeforeImages(before, options);

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

        const after = scanScopedRoots(roots, { caseSensitive, skip: isVolatileChurnPath, rootBounds });
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
          ...(beforeImages.size === 0 ? {} : { beforeImages }),
        };
      },
    };
  }

  /**
   * Reads and hashes each pre-existing regular file that fits the backup limit, returning its
   * content by address. Over-limit or unreadable files are skipped: the mutation is still recorded,
   * it just is not restorable.
   */
  private async captureBeforeImages(before: ScopedSnapshot, options: CaptureStartOptions): Promise<Map<string, Uint8Array>> {
    const backups = options.backups;
    const images = new Map<string, Uint8Array>();
    if (backups === undefined || !backups.enabled) return images;

    for (const node of before.entries.values()) {
      if (node.kind !== "file" || node.size > backups.sizeLimitBytes) continue;
      const bytes = await this.read(node.path);
      if (bytes === undefined) continue;
      node.hash = hashBytes(bytes);
      images.set(node.hash, bytes);
    }
    return images;
  }

  /**
   * Bounds only the `$HOME` root, when it is among the observed roots (defect #3). Every other root
   * keeps the engine's default: the root itself is the only bound.
   */
  private homeRootBounds(roots: AbsolutePath[]): ReadonlyMap<AbsolutePath, ScopedRootBounds> | undefined {
    const home = this.home;
    if (home === undefined) return undefined;
    const homeRoot = roots.find((root) => root === home);
    if (homeRoot === undefined) return undefined;
    return new Map([[homeRoot, macosHomeRootBounds(homeRoot)]]);
  }

  private partialReason(scanErrors: string[], hashErrors: AbsolutePath[]): string | undefined {
    const reasons: string[] = [];
    if (scanErrors.length > 0) reasons.push(`some scope roots could not be scanned: ${scanErrors.join("; ")}`);
    if (hashErrors.length > 0) reasons.push(`some files could not be hashed: ${hashErrors.join(", ")}`);
    return reasons.length > 0 ? reasons.join("; ") : undefined;
  }
}
