import type { Baseline, CapturedBaseline, FsInspector } from "./inspect";
import type { CaptureBackend, CaptureSession, CaptureStartOptions } from "../backend";
import type { LinuxTracer, LinuxTracerFactory, TracerAttachOptions } from "./tracer";
import { MemoryBaseline, RealFsInspector, captureBaseline } from "./inspect";
import { existsSync, readFileSync } from "node:fs";
import type { AbsolutePath } from "../../../types";
import type { BlobId } from "../../storage";
import type { Journal } from "../events";
import type { TracerResult } from "./raw";
import { attachStrace } from "./tracer";
import { reconstruct } from "./reconstruct";

/**
 * First-class Linux `CaptureBackend` (plan section 8, D7). It attaches a `LinuxTracer` to the
 * installer process tree for one bounded window, captures an existence baseline so a create can be
 * told from an overwrite, reconstructs journal events, and reports completeness from what the tracer
 * could actually prove.
 *
 * Completeness is never assumed complete: the journal is downgraded to `partial` when the tracer
 * lost a tracee (a uid transition), was denied attach, saw a syscall whose effect the journal cannot
 * represent (`mmap` writes, kernel copies, ownership changes), could not resolve a path, or was still
 * attached to a live descendant when the window closed (daemonization). Fanotify is always partial
 * while its helper omits directory events and real-kernel tests have not established full coverage.
 * A record only ever carries `complete` when the tracer observed the whole tree through its natural exit.
 */
export type LinuxCaptureBackendOptions = {
  /** Builds the attached tracer; defaults to the strace (unprivileged ptrace) tracer. */
  tracerFactory?: LinuxTracerFactory;
  /** Filesystem inspector; defaults to the real one. Tests inject a fake. */
  inspector?: FsInspector;
  /** Existence baseline; defaults to capturing one over the observe roots. */
  baseline?: Baseline | "capture" | "none";
  /** Advisory backend name before a tracer is attached (for example "linux-strace"). */
  name?: string;
  /** How long to wait for the tracer to detach before treating a live tracer as incomplete. */
  settleMs?: number;
  /** Liveness probe for pids the tracer recorded; injectable so tests stay hermetic. */
  processAlive?: (pid: number) => boolean;
};

/** The pre-window baseline plus any before-image bytes the capture read alongside it. */
type ResolvedBaseline = {
  baseline: Baseline;
  beforeImages: Map<BlobId, Uint8Array>;
};

export class LinuxCaptureBackend implements CaptureBackend {
  readonly name: string;
  readonly completeness = "complete" as const;

  private readonly options: LinuxCaptureBackendOptions;
  private readonly inspector: FsInspector;
  private readonly settleMs: number;
  private readonly processAlive: (pid: number) => boolean;

  constructor(options: LinuxCaptureBackendOptions = {}) {
    this.options = options;
    this.name = options.name ?? "linux-strace";
    this.inspector = options.inspector ?? new RealFsInspector();
    this.settleMs = options.settleMs ?? 200;
    this.processAlive = options.processAlive ?? procProcessAlive;
  }

  async start(options: CaptureStartOptions): Promise<CaptureSession> {
    const attach: TracerAttachOptions = { pid: options.pid, roots: options.roots };
    // Known host restrictions always force the install into the heuristic fallback. Check them
    // before a backups-enabled baseline reads every eligible file in the observation roots.
    const tracerFactory = this.options.tracerFactory ?? defaultTracerFactoryForCurrentHost();
    const resolved = await this.resolveBaseline(options);
    const tracer = await tracerFactory(attach);

    return {
      backend: tracer.name,
      stop: async (): Promise<Journal> => this.stop(tracer, options.roots, resolved, options.pid),
    };
  }

  private async stop(
    tracer: LinuxTracer,
    roots: AbsolutePath[],
    resolved: ResolvedBaseline,
    rootPid: number,
  ): Promise<Journal> {
    // A live tracer at the close of the window means tracees (a daemonized or detached descendant)
    // outlived the bounded install window; their later activity is not captured. The observed root
    // itself is excluded: for an install window it is the caller's own process, alive by
    // construction, so only a *descendant* it kept running past the window lowers coverage.
    const settled = await waitForInactive(tracer, this.settleMs);
    const beforeStopLosses = tracer.losses();
    await tracer.stop();
    const traced = await tracer.records();
    const result = await reconstruct({
      traced,
      inspector: this.inspector,
      baseline: resolved.baseline,
      roots,
      fallbackAt: Date.now(),
    });

    const reasons = new Set<string>([...beforeStopLosses, ...tracer.losses()]);
    if (tracer.name === "linux-fanotify") {
      reasons.add(
        "fanotify helper omits directory events (including mkdir/rmdir); full coverage has not been established by real-kernel tests",
      );
    }
    for (const diagnostic of traced.diagnostics) reasons.add(diagnostic);
    for (const diagnostic of result.diagnostics) reasons.add(diagnostic);
    if (traced.unsupported.length > 0) {
      reasons.add(`unsupported syscalls may change files without journal events: ${traced.unsupported.join(", ")}`);
    }
    if (!settled && hasLiveDescendants(traced, rootPid, this.processAlive)) {
      reasons.add(
        "capture closed while the tracer was still attached to live descendants (daemonized or detached processes were not observed to their end)",
      );
    }

    const completeness = reasons.size === 0 ? "complete" : "partial";
    const journal: Journal = {
      backend: tracer.name,
      completeness,
      events: result.events,
    };
    if (reasons.size > 0) journal.partialReason = [...reasons].join("; ");
    // Present only when the walk actually read bytes (backups enabled), so a caller's
    // `availableBeforeImages` stays empty and no record advertises an unrestorable before-image.
    if (resolved.beforeImages.size > 0) journal.beforeImages = resolved.beforeImages;
    return journal;
  }

  private async resolveBaseline(options: CaptureStartOptions): Promise<ResolvedBaseline> {
    const configured = this.options.baseline;
    if (configured === undefined || configured === "capture") {
      // The baseline is scoped to the observe roots; with backups enabled it also reads each
      // eligible file once, for its before-image (see `captureBaseline`).
      const captured: CapturedBaseline = await captureBaseline(
        options.roots,
        options.backups === undefined ? { inspector: this.inspector } : { backups: options.backups, inspector: this.inspector },
      );
      return captured;
    }
    if (configured === "none") return { baseline: new MemoryBaseline(), beforeImages: new Map() };
    return { baseline: configured, beforeImages: new Map() };
  }
}

/**
 * The CLI always attempts strace, including when already root. Fanotify has not established
 * capture fidelity and is available only through explicit development tracer injection.
 */
export async function defaultTracerFactory(attach: TracerAttachOptions): Promise<LinuxTracer> {
  return defaultTracerFactoryForCurrentHost()(attach);
}

function defaultTracerFactoryForCurrentHost(): LinuxTracerFactory {
  const selection = selectDefaultTracer();
  return (attach) => attachDefaultTracer(attach, selection);
}

type DefaultTracerSelection = { stracePath: string };

/** Selects a tracer only when the host can plausibly attach it; this runs before the baseline scan. */
function selectDefaultTracer(): DefaultTracerSelection {
  if (parentAttachRestricted()) {
    throw new Error(
      "strace cannot attach to this process: yama ptrace_scope restricts an unprivileged tracer from tracing its parent",
    );
  }
  const stracePath = Bun.which("strace");
  if (stracePath === null) {
    throw new Error('strace could not start: Executable not found in $PATH: "strace"');
  }
  return { stracePath };
}

/** Attaches the previously selected tracer only after the baseline has been captured. */
async function attachDefaultTracer(attach: TracerAttachOptions, selection: DefaultTracerSelection): Promise<LinuxTracer> {
  const tracer = await attachStrace(attach, { cwd: process.cwd(), stracePath: selection.stracePath });
  await requireAttached(tracer);
  return tracer;
}

/**
 * True when the kernel's Yama LSM forbids this unprivileged process from tracing its own parent — the
 * relationship `strace -f -p <parent>` needs. Under `ptrace_scope >= 1` a child may only trace its
 * descendants, so the attach can never succeed; detecting that up front keeps the caller's heuristic
 * fallback deterministic instead of racing the tracer's exit. Exported so callers and tests can
 * predict which backend an install window will get.
 */
export function parentAttachRestricted(): boolean {
  if (isRoot()) return false;
  try {
    const scope = Number.parseInt(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim(), 10);
    return Number.isFinite(scope) && scope >= 1;
  } catch {
    return false; // no Yama (or unreadable): assume the attach is allowed and let strace report
  }
}

/**
 * Rejects a tracer that died before it could attach. `strace -p <parent>` is refused under the
 * default `ptrace_scope=1` (an unprivileged child may not trace its parent), and without this check
 * that failure is only a loss reason on a journal returned after the installer has already run
 * unwatched. Throwing here lets the caller fall back to a heuristic window *before* the install runs,
 * so the install is still attributed instead of recorded as an empty journal with no executable.
 */
async function requireAttached(tracer: LinuxTracer, graceMs = 250): Promise<void> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const reasons = tracer.losses();
    // A spawn failure (strace missing) leaves the child object "alive" with no exit code, so the loss
    // reason is the only signal; an attach refusal instead exits the child, caught by the status check.
    if (reasons.some(isAttachFailure)) {
      throw new Error(`strace could not attach: ${reasons.join("; ")}`);
    }
    if (!(await tracer.status()).active) {
      throw new Error(`strace could not attach: ${reasons.length > 0 ? reasons.join("; ") : "tracer exited before attaching"}`);
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A tracer loss that means the tracer never began observing, so the window has no coverage at all. */
function isAttachFailure(reason: string): boolean {
  return /could not (?:start|attach)|Operation not permitted/i.test(reason);
}

/** Reads caller privilege without escalation; used by the Yama preflight. */
export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Waits up to `settleMs` for the tracer to detach; returns false if it is still attached. */
async function waitForInactive(tracer: LinuxTracer, settleMs: number): Promise<boolean> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    if (!(await tracer.status()).active) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Whether any traced process other than the observed root was still alive when the window closed.
 * The root is excluded because an install window observes the caller's own process, which is alive
 * by construction; a daemonized or detached descendant keeps its recorded pid alive past the
 * window. Best-effort: a descendant that issued no traced syscall never appears in the records, and
 * a reused pid reads as alive.
 */
function hasLiveDescendants(traced: TracerResult, rootPid: number, alive: (pid: number) => boolean): boolean {
  const seen = new Set<number>();
  for (const record of traced.records) {
    const pid = record.pid;
    if (pid === undefined || pid === rootPid || seen.has(pid)) continue;
    seen.add(pid);
    if (alive(pid)) return true;
  }
  return false;
}

/** Default liveness probe: `/proc/<pid>` exists. */
function procProcessAlive(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}
