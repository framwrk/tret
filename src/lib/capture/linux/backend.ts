import type { Baseline, FsInspector } from "./inspect";
import type { CaptureBackend, CaptureSession, CaptureStartOptions } from "../backend";
import type { LinuxTracer, LinuxTracerFactory, TracerAttachOptions } from "./tracer";
import { MemoryBaseline, RealFsInspector, captureBaseline } from "./inspect";
import { attachFanotify, attachStrace } from "./tracer";
import type { AbsolutePath } from "../../../types";
import type { Journal } from "../events";
import { existsSync } from "node:fs";
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
 * attached to a live descendant when the window closed (daemonization). A record only ever carries
 * `complete` when the tracer observed the whole tree through its natural exit.
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
};

export class LinuxCaptureBackend implements CaptureBackend {
  readonly name: string;
  readonly completeness = "complete" as const;

  private readonly options: LinuxCaptureBackendOptions;
  private readonly inspector: FsInspector;
  private readonly settleMs: number;

  constructor(options: LinuxCaptureBackendOptions = {}) {
    this.options = options;
    this.name = options.name ?? "linux-strace";
    this.inspector = options.inspector ?? new RealFsInspector();
    this.settleMs = options.settleMs ?? 200;
  }

  async start(options: CaptureStartOptions): Promise<CaptureSession> {
    const attach: TracerAttachOptions = { pid: options.pid, roots: options.roots };
    const baseline = await this.resolveBaseline(options.roots);
    const tracer = await (this.options.tracerFactory ?? defaultTracerFactory)(attach);

    return {
      backend: tracer.name,
      stop: async (): Promise<Journal> => this.stop(tracer, options.roots, baseline),
    };
  }

  private async stop(tracer: LinuxTracer, roots: AbsolutePath[], baseline: Baseline): Promise<Journal> {
    // A live tracer at the close of the window means tracees (a daemonized or detached descendant)
    // outlived the bounded install window; their later activity is not captured.
    const settled = await waitForInactive(tracer, this.settleMs);
    const beforeStopLosses = tracer.losses();
    await tracer.stop();
    const traced = await tracer.records();
    const result = await reconstruct({
      traced,
      inspector: this.inspector,
      baseline,
      roots,
      fallbackAt: Date.now(),
    });

    const reasons = new Set<string>([...beforeStopLosses, ...tracer.losses()]);
    for (const diagnostic of traced.diagnostics) reasons.add(diagnostic);
    if (traced.unsupported.length > 0) {
      reasons.add(`unsupported syscalls may change files without journal events: ${traced.unsupported.join(", ")}`);
    }
    if (!settled) {
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
    return journal;
  }

  private async resolveBaseline(roots: AbsolutePath[]): Promise<Baseline> {
    const configured = this.options.baseline;
    if (configured === undefined || configured === "capture") {
      // The baseline is scoped to the observe roots and reads no content (see `captureBaseline`).
      return captureBaseline(roots);
    }
    if (configured === "none") return new MemoryBaseline();
    return configured;
  }
}

/**
 * Default tracer selection (D7, D8): when the process already holds root (the user ran tret under
 * sudo, not an escalation tret performs itself) and the fanotify helper is present, use the
 * privileged fanotify tracer; otherwise use the unprivileged strace/ptrace tracer. Tret never
 * escalates on the user's behalf.
 */
export async function defaultTracerFactory(attach: TracerAttachOptions): Promise<LinuxTracer> {
  const helper = fanotifyHelperPath();
  if (isRoot() && helper !== undefined) return attachFanotify(attach, { helperPath: helper });
  return attachStrace(attach, { cwd: process.cwd() });
}

/** The fanotify helper path when it is present; Tret never installs or elevates it itself. */
function fanotifyHelperPath(): string | undefined {
  const configured = process.env.TRET_FANOTIFY;
  return configured !== undefined && existsSync(configured) ? configured : undefined;
}

/** Convenience predicate used by install integration to decide whether a privileged tracer is viable. */
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
