import type { Baseline, CapturedBaseline, FsInspector } from "./inspect";
import type { CaptureBackend, CaptureCommand, CaptureSession, CaptureStartOptions } from "../backend";
import type { Journal, JournalEvent } from "../events";
import type { LinuxTracer, LinuxTracerFactory, TracerAttachOptions } from "./tracer";
import { MemoryBaseline, RealFsInspector, captureBaseline } from "./inspect";
import { excludePrivateState, privateStateFilter } from "../self-state";
import { existsSync, readFileSync } from "node:fs";
import type { AbsolutePath } from "../../../types";
import type { BlobId } from "../../storage";
import { CaptureBudget } from "../budget";
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
  private inspector: FsInspector;
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
    const budget = options.budget ?? new CaptureBudget();
    budget.ensurePhase();
    const attach: TracerAttachOptions = { pid: options.pid, roots: options.roots, budget };
    const command = this.options.tracerFactory ? undefined : options.command;
    const tracerFactory = this.options.tracerFactory ?? defaultTracerFactoryForCurrentHost(command);
    if (!this.options.inspector) this.inspector = new RealFsInspector({ budget });
    const resolved = await this.resolveBaseline({ ...options, budget });
    budget.check();
    const tracer = await tracerFactory(attach);
    budget.pause();
    let prefixRecords = 0;
    const prefixEvents: JournalEvent[] = [];
    const prefixState = { live: new Map<AbsolutePath, "created" | "existing">(), nextSequence: 0 };

    return {
      backend: tracer.name,
      beforeImages: resolved.beforeImages,
      ...(resolved.baseline instanceof MemoryBaseline ? { baseline: resolved.baseline.snapshot() } : {}),
      ...(command && tracer.runProgram ? { runProgram: tracer.runProgram } : {}),
      ready: async () => {
        if (!(await tracer.status()).active || (tracer.isAttached && !(await tracer.isAttached())))
          throw new Error("strace could not attach: capture was lost before external execution");
      },
      ...(tracer.checkpoint ? { checkpoint: async (): Promise<Journal | undefined> => {
        const traced = payloadTrace(await tracer.checkpoint!(), options.pid);
        if (traced.records.length < prefixRecords) throw new Error("tracer prefix cursor moved backwards");
        if (traced.records.length === prefixRecords && traced.diagnostics.length === 0) return undefined;
        const delta = { ...traced, records: traced.records.slice(prefixRecords) };
        const result = await reconstruct({ traced: delta, inspector: this.inspector, baseline: resolved.baseline,
          roots: options.roots, fallbackAt: Date.now(), budget, metadataOnly: true, state: prefixState });
        prefixRecords = traced.records.length;
        prefixEvents.push(...result.events);
        for (const reason of [...traced.diagnostics, ...result.diagnostics, ...tracer.losses()]) budget.note(reason);
        return { backend: tracer.name, completeness: "partial", events: prefixEvents.slice(), resources: budget.report(),
          partialReason: ["live event prefix; end-of-window state and the subsequent interval remain unknown", ...budget.losses].join("; ") };
      } } : {}),
      stop: async (): Promise<Journal> => this.stop(tracer, options.roots, resolved, options.pid, budget, command !== undefined),
    };
  }

  async preflight(childLaunch = false): Promise<void> {
    if (!this.options.tracerFactory) selectDefaultTracer(childLaunch);
  }

  private async stop(
    tracer: LinuxTracer,
    roots: AbsolutePath[],
    resolved: ResolvedBaseline,
    rootPid: number,
    budget: CaptureBudget,
    childLaunch: boolean,
  ): Promise<Journal> {
    // A live tracer at the close of the window means tracees (a daemonized or detached descendant)
    // outlived the bounded install window; their later activity is not captured. The observed root
    // itself is excluded: for an install window it is the caller's own process, alive by
    // construction, so only a *descendant* it kept running past the window lowers coverage.
    const settled = await waitForInactive(tracer, this.settleMs);
    const beforeStopLosses = tracer.losses();
    await tracer.stop();
    const traced = payloadTrace(await tracer.records(), rootPid);
    budget.beginPhase();
    const result = await reconstruct({
      traced,
      inspector: this.inspector,
      baseline: resolved.baseline,
      roots,
      fallbackAt: Date.now(),
      budget,
    });

    const reasons = new Set<string>([...beforeStopLosses, ...tracer.losses(), ...(resolved.baseline.diagnostics ?? []), ...budget.losses]);
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
    if (!settled && (childLaunch || hasLiveDescendants(traced, rootPid, this.processAlive))) {
      reasons.add(
        "capture closed while the tracer was still attached to live descendants (daemonized or detached processes were not observed to their end)",
      );
    }

    const completeness = reasons.size === 0 ? "complete" : "partial";
    const journal: Journal = {
      backend: tracer.name,
      completeness,
      events: result.events,
      resources: budget.report(),
    };
    if (reasons.size > 0) journal.partialReason = [...reasons].join("; ");
    // Present only when the walk actually read bytes (backups enabled), so a caller's
    // `availableBeforeImages` stays empty and no record advertises an unrestorable before-image.
    if (resolved.beforeImages.size > 0) journal.beforeImages = resolved.beforeImages;
    budget.pause();
    return excludePrivateState(journal, process.env.HOME, rootPid);
  }

  private async resolveBaseline(options: CaptureStartOptions): Promise<ResolvedBaseline> {
    const configured = this.options.baseline;
    if (configured === undefined || configured === "capture") {
      // The baseline is scoped to the observe roots; with backups enabled it also reads each
      // eligible file once, for its before-image (see `captureBaseline`).
      const captured: CapturedBaseline = await captureBaseline(
        options.roots,
        { inspector: this.inspector, budget: options.budget, ...(options.backups ? { backups: options.backups } : {}) },
      );
      return captured;
    }
    if (configured === "none") return { baseline: new MemoryBaseline(), beforeImages: new Map() };
    return { baseline: configured, beforeImages: new Map() };
  }
}

/** Drop private bookkeeping before filesystem inspection, preserving child-state exclusion diagnostics. */
function payloadTrace(traced: TracerResult, rootPid: number): TracerResult {
  const excluded = privateStateFilter();
  let childState = false;
  const records = traced.records.filter(record => {
    // Boundary renames need endpoint-by-endpoint reconstruction. Pure bookkeeping still drops
    // before inspection; defer spellings with traversal components to kernel-aware resolution.
    if (record.op === "rename") {
      const privateOnly = [record.from, record.to].every(path => excluded(path) && !path.split("/").includes(".."));
      if (privateOnly && record.pid !== rootPid) childState = true;
      return !privateOnly;
    }
    const paths = "path" in record && record.path ? [record.path] : [];
    const keep = !paths.some(excluded);
    if (!keep && record.pid !== rootPid) childState = true;
    return keep;
  });
  return { ...traced, records, diagnostics: childState ? [...traced.diagnostics.slice(0, 31), "private Tret state events excluded; changes to this state are not installation payload"] : traced.diagnostics };
}

/**
 * The CLI always attempts strace, including when already root. Fanotify has not established
 * capture fidelity and is available only through explicit development tracer injection.
 */
export async function defaultTracerFactory(attach: TracerAttachOptions): Promise<LinuxTracer> {
  return defaultTracerFactoryForCurrentHost()(attach);
}

function defaultTracerFactoryForCurrentHost(command?: CaptureCommand): LinuxTracerFactory {
  const selection = selectDefaultTracer(command !== undefined);
  return (attach) => attachDefaultTracer(attach, selection, command);
}

type DefaultTracerSelection = { stracePath: string };

/** Selects a tracer only when the host can plausibly attach it; this runs before the baseline scan. */
function selectDefaultTracer(childLaunch = false): DefaultTracerSelection {
  const scope = yamaScope();
  if (childLaunch ? scope >= 3 || (scope >= 2 && !isRoot()) : scope >= 1 && !isRoot()) {
    throw new Error(
      childLaunch ? "strace child launch is restricted by yama ptrace_scope" :
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
async function attachDefaultTracer(attach: TracerAttachOptions, selection: DefaultTracerSelection, command?: CaptureCommand): Promise<LinuxTracer> {
  const tracer = await attachStrace(attach, { cwd: process.cwd(), stracePath: selection.stracePath, command });
  try { await requireAttached(tracer); }
  catch (error) {
    try { await tracer.stop(); } catch { /* Preserve the original attachment failure. */ }
    throw error;
  }
  return tracer;
}

/**
 * True when the kernel's Yama LSM forbids this unprivileged process from tracing its own parent — the
 * relationship `strace -f -p <parent>` needs. Under `ptrace_scope >= 1` a child may only trace its
 * descendants, so the attach can never succeed; detecting that up front keeps the caller's heuristic
 * fallback deterministic instead of racing the tracer's exit. This applies to the direct-attach
 * seam, not the CLI child launch.
 */
export function parentAttachRestricted(): boolean {
  return !isRoot() && yamaScope() >= 1;
}

function yamaScope(): number {
  try {
    const scope = Number.parseInt(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim(), 10);
    return Number.isFinite(scope) ? scope : 0;
  } catch {
    return 0;
  }
}

/**
 * Requires kernel-confirmed attachment, rather than accepting a live tracer after a delay.
 * `strace -p <parent>` is refused under the
 * default `ptrace_scope=1` (an unprivileged child may not trace its parent), and without this check
 * that failure is only a loss reason on a journal returned after the installer has already run
 * unwatched. Throwing here lets the caller fall back to a heuristic window *before* the install runs,
 * so the install is still attributed instead of recorded as an empty journal with no executable.
 */
async function requireAttached(tracer: LinuxTracer, graceMs = 5000): Promise<void> {
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
    if (await tracer.isAttached?.()) return;
    if (Date.now() >= deadline) throw new Error("strace could not attach: kernel attachment was not confirmed before the deadline");
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
