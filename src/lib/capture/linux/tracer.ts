import type { TracerRecord, TracerResult } from "./raw";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AbsolutePath } from "../../../types";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { parseStraceOutput } from "./strace";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * An attached Linux observation mechanism. The backend depends only on this seam, so the strace
 * (unprivileged ptrace) tracer, the privileged fanotify helper, and a test double are
 * interchangeable (plan section 8, D7).
 */
export interface LinuxTracer {
  /** Identifier stored in `record.capture.backend`. */
  readonly name: string;
  /** Parses the tracer's captured output into records. */
  records(): Promise<TracerResult>;
  /** Reasons the tracer already knows coverage is incomplete (attach denied, uid transition, overflow). */
  losses(): string[];
  /** Whether the tracer is still attached as the window closes and how many descendants it sees. */
  status(): Promise<TracerStatus>;
  /** Detaches and waits for the tracer to exit; safe to call more than once. */
  stop(): Promise<void>;
}

export type TracerStatus = {
  /** True while the tracer is still attached to live tracees. */
  active: boolean;
  /** Best-effort count of live descendants known to the tracer, when it can report one. */
  tracedDescendants: number;
};

/** Options every tracer needs to attach to one bounded install window. */
export type TracerAttachOptions = {
  /** Process id of the installer; its descendants are the attribution target. */
  pid: number;
  /** Absolute roots to observe; events outside them are dropped. */
  roots: AbsolutePath[];
};

/** Builds an attached tracer for one window; injected so tests can substitute a double. */
export type LinuxTracerFactory = (options: TracerAttachOptions) => Promise<LinuxTracer>;

// --- strace (unprivileged ptrace) -----------------------------------------------------------------

/**
 * Syscalls the strace tracer requests. The journal-relevant set is traced for attribution; the
 * "unsupported" set is traced so content/metadata changes the journal cannot represent are
 * reported instead of silently missed. `mmap` is filtered in the parser to shared writable
 * file-backed mappings only, so ordinary allocations do not flood the trace.
 */
export const STRACE_TRACE_SET = [
  "open",
  "openat",
  "openat2",
  "creat",
  "write",
  "pwrite64",
  "writev",
  "pwritev",
  "truncate",
  "ftruncate",
  "rename",
  "renameat",
  "renameat2",
  "unlink",
  "unlinkat",
  "chmod",
  "fchmod",
  "fchmodat",
  "fchmodat2",
  "symlink",
  "symlinkat",
  "mkdir",
  "mkdirat",
  "rmdir",
  "close",
  "dup",
  "dup2",
  "dup3",
  "mmap",
  "sendfile",
  "copy_file_range",
  "fallocate",
  "chown",
  "lchown",
  "fchown",
  "fchownat",
  "setxattr",
  "lsetxattr",
  "fsetxattr",
  "removexattr",
  "mknod",
  "mknodat",
  "mkfifo",
  "link",
  "linkat",
].join(",");

export type StraceTracerOptions = {
  /** Path to the `strace` binary; overridable so tests can use a fake tracer script. */
  stracePath?: string;
  /** Grace period to let strace detach on its own after the installer exits. */
  detachGraceMs?: number;
  /** Working directory used to resolve paths strace reports relative to `AT_FDCWD`. */
  cwd?: AbsolutePath;
  /** Extra environment for the spawned tracer; injected so tests can run a hermetic fake tracer. */
  env?: Record<string, string>;
};

/**
 * Unprivileged ptrace tracer. It runs `strace -f -p <installer>` so it follows forked, double-forked
 * and `setsid` descendants for as long as they stay traceable. The deliberate blind spots are:
 * - a `setuid`/`setgid` `execve` makes a descendant non-dumpable and drops tracing (reported);
 * - attaching requires the tracer to be the parent or `ptrace_scope` to allow it (reported);
 * - paths relative to an unknown cwd, and fds inherited across an untraced fork, degrade to
 *   diagnostics rather than guessed attribution.
 */
export class StraceTracer implements LinuxTracer {
  readonly name = "linux-strace";
  private readonly options: StraceTracerOptions;
  private readonly attach: TracerAttachOptions;
  private child: ReturnType<typeof spawn> | undefined;
  private exit: Promise<void> | undefined;
  private outputDir: string | undefined;
  private outputFile: string | undefined;
  private stderr = "";
  private readonly lossReasons: string[] = [];
  private stopped = false;
  private cached: TracerResult | undefined;

  constructor(attach: TracerAttachOptions, options: StraceTracerOptions = {}) {
    this.attach = attach;
    this.options = options;
  }

  async attachProcess(): Promise<void> {
    this.outputDir = await mkdtemp(join(tmpdir(), "tret-strace-"));
    this.outputFile = join(this.outputDir, "trace");
    const args = [
      "-f",
      "-ttt",
      "-y",
      "-qq",
      "-s",
      "4096",
      "-e",
      `trace=${STRACE_TRACE_SET}`,
      "-o",
      this.outputFile,
      "-p",
      String(this.attach.pid),
    ];
    const child = spawn(this.options.stracePath ?? "strace", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: this.options.env === undefined ? process.env : { ...process.env, ...this.options.env },
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exit = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", (error) => {
        this.lossReasons.push(`strace could not start: ${error.message}`);
        resolve();
      });
    });
  }

  async records(): Promise<TracerResult> {
    if (this.cached === undefined) this.cached = await this.collect();
    return this.cached;
  }

  /** Reads and parses the trace and folds any strace stderr into loss reasons. */
  private async collect(): Promise<TracerResult> {
    if (this.outputFile === undefined) return { records: [], unsupported: [], diagnostics: ["strace never attached"] };
    let text: string;
    try {
      text = await readFile(this.outputFile, "utf8");
    } catch {
      return { records: [], unsupported: [], diagnostics: ["strace produced no output"] };
    }
    const parsed = parseStraceOutput(text, { cwd: this.options.cwd, roots: this.attach.roots });
    for (const line of this.stderr.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (looksLikeTraceLoss(trimmed)) this.lossReasons.push(trimmed);
      else if (trimmed.startsWith("strace:")) this.lossReasons.push(trimmed);
    }
    return parsed;
  }

  losses(): string[] {
    return dedupe(this.lossReasons);
  }

  async status(): Promise<TracerStatus> {
    return { active: this.isAlive(), tracedDescendants: 0 };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    if (child && this.isAlive()) {
      // SIGINT makes strace detach from every tracee and exit cleanly.
      child.kill("SIGINT");
      await this.waitOrKill(child, this.options.detachGraceMs ?? 250);
    }
    await this.exit;
    // Parse before removing the output directory so `records()` stays usable after `stop()`.
    if (this.cached === undefined) this.cached = await this.collect();
    if (this.outputDir !== undefined) {
      await rm(this.outputDir, { recursive: true, force: true });
    }
  }

  private isAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  private async waitOrKill(child: ReturnType<typeof spawn>, graceMs: number): Promise<void> {
    const exited = await Promise.race([this.exit?.then(() => true), delay(graceMs).then(() => false)]);
    if (!exited) {
      child.kill("SIGKILL");
      await this.exit;
    }
  }
}

/** Starts a strace tracer for one window; used as the default `LinuxTracerFactory`. */
export async function attachStrace(attach: TracerAttachOptions, options: StraceTracerOptions = {}): Promise<LinuxTracer> {
  const tracer = new StraceTracer(attach, options);
  await tracer.attachProcess();
  return tracer;
}

// --- fanotify (privileged kernel helper) ---------------------------------------------------------

export type FanotifyTracerOptions = {
  /** Path to the `tret-fanotify` helper; overridable so tests can use a fake helper script. */
  helperPath?: string;
  /** Extra environment for the spawned helper; injected so tests can run a hermetic double. */
  env?: Record<string, string>;
};

/**
 * Privileged fanotify tracer. It spawns the `tret-fanotify` helper (see `helper/tret-fanotify.c`),
 * which takes `FAN_CLASS_NOTIF` marks on `--roots`, reports PID/pidfd per event, pairs
 * `FAN_MOVED_FROM`/`FAN_MOVED_TO`, and emits newline-delimited `TracerRecord` JSON. This path
 * requires `CAP_SYS_ADMIN` (or root) for PID reporting; the backend only selects it when the process
 * already has that privilege, and it never escalates (D8). Coverage gaps it reports: queue overflow,
 * network filesystems, and mounts it could not mark.
 */
export class FanotifyTracer implements LinuxTracer {
  readonly name = "linux-fanotify";
  private readonly options: FanotifyTracerOptions;
  private readonly attach: TracerAttachOptions;
  private child: ReturnType<typeof spawn> | undefined;
  private exit: Promise<void> | undefined;
  private readonly recordsOut: TracerRecord[] = [];
  private readonly unsupported = new Set<string>();
  private readonly diagnostics: string[] = [];
  private readonly lossReasons: string[] = [];
  private stopped = false;
  private reading: Promise<void> | undefined;

  constructor(attach: TracerAttachOptions, options: FanotifyTracerOptions = {}) {
    this.attach = attach;
    this.options = options;
  }

  async attachProcess(): Promise<void> {
    const args = ["--pid", String(this.attach.pid), ...this.attach.roots.flatMap((root) => ["--root", root])];
    const child = spawn(this.options.helperPath ?? "tret-fanotify", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.options.env === undefined ? process.env : { ...process.env, ...this.options.env },
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.lossReasons.push(trimmed);
      }
    });
    this.reading = this.readStdout(child);
    this.exit = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", (error) => {
        this.lossReasons.push(`fanotify helper could not start: ${error.message}`);
        resolve();
      });
    });
  }

  private async readStdout(child: ReturnType<typeof spawn>): Promise<void> {
    if (!child.stdout) return;
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("@")) {
        // Helper control message, e.g. `@loss <reason>`.
        this.lossReasons.push(trimmed.slice(1).trim());
        continue;
      }
      try {
        const record = JSON.parse(trimmed) as TracerRecord;
        if (record.op === "unsupported") this.unsupported.add(record.syscall);
        this.recordsOut.push(record);
      } catch {
        this.diagnostics.push(`fanotify helper emitted an unreadable line: ${trimmed.slice(0, 120)}`);
      }
    }
  }

  async records(): Promise<TracerResult> {
    await this.reading;
    return {
      records: this.recordsOut.slice(),
      unsupported: [...this.unsupported].sort(),
      diagnostics: this.diagnostics.slice(),
    };
  }

  losses(): string[] {
    return dedupe(this.lossReasons);
  }

  async status(): Promise<TracerStatus> {
    return { active: this.isAlive(), tracedDescendants: 0 };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    if (child && this.isAlive()) {
      child.kill("SIGTERM");
      await Promise.race([this.exit?.then(() => true), delay(500).then(() => false)]);
      if (this.isAlive()) child.kill("SIGKILL");
    }
    await this.exit;
    await this.reading;
  }

  private isAlive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }
}

/** Starts a fanotify tracer for one window. */
export async function attachFanotify(attach: TracerAttachOptions, options: FanotifyTracerOptions = {}): Promise<LinuxTracer> {
  const tracer = new FanotifyTracer(attach, options);
  await tracer.attachProcess();
  return tracer;
}

// --- helpers --------------------------------------------------------------------------------------

function looksLikeTraceLoss(line: string): boolean {
  return (
    line.includes("Could not attach") ||
    line.includes("Operation not permitted") ||
    line.includes("ptrace") ||
    line.includes("setuid") ||
    line.includes("+++ killed by") ||
    line.includes("lost")
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
