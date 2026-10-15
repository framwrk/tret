import type { LinuxTracer, TracerStatus } from "./tracer";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AbsolutePath } from "../../../types";
import { LinuxCaptureBackend } from "./backend";
import { STRACE_TRACE_SET } from "./tracer";
import type { TracerResult } from "./raw";
import { join } from "node:path";
import { normalizeJournal } from "../normalize";
import { parseStraceOutput } from "./strace";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Real-strace smoke test (plan 02 item 4). The hermetic fake-tracer tests keep edge cases
 * deterministic; this one runs a representative installer through the real `strace` parser,
 * `reconstruct`, and `LinuxCaptureBackend` on Linux, with no elevated permissions.
 *
 * Production attaches with `strace -f -p <installer>`. Under Yama `ptrace_scope=1` an unprivileged
 * tracer may only trace its own descendants, so this test instead runs the installer *under*
 * `strace` (strace as parent), which the kernel always permits. The `-p` spawn/attach plumbing is
 * covered separately by the fake-strace tests; what is exercised here is the syscall parsing,
 * path resolution, reconstruction, and coverage reporting against genuine kernel output.
 */

const STRACE = Bun.which("strace");
const ENABLED = process.platform === "linux" && STRACE !== null;

/** Options the test hands to the parent-mode tracer. */
type ParentStraceOptions = {
  roots: AbsolutePath[];
  cwd: AbsolutePath;
  /** Absolute path of the installer script strace runs. */
  script: AbsolutePath;
};

/** Test-only tracer adapter that spawns `strace -f -o <file> bash <script>`. */
class ParentStraceTracer implements LinuxTracer {
  readonly name = "linux-strace";
  private readonly child: ReturnType<typeof spawn>;
  private readonly outputFile: string;
  private readonly attach: ParentStraceOptions;
  private readonly exit: Promise<void>;
  private cached?: TracerResult;

  constructor(options: ParentStraceOptions, traceDir: AbsolutePath) {
    this.attach = options;
    this.outputFile = join(traceDir, "trace.out");
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
      "bash",
      options.script,
    ];
    this.child = spawn(STRACE as string, args, {
      stdio: ["ignore", "ignore", "pipe"],
      cwd: options.cwd,
      env: { ...process.env, HOME: options.cwd },
    });
    this.exit = new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.once("error", () => resolve());
    });
  }

  /** Resolves when the traced installer (and strace itself) has exited. */
  wait(): Promise<void> {
    return this.exit;
  }

  async records(): Promise<TracerResult> {
    await this.exit;
    this.cached ??= parseStraceOutput(readFileSync(this.outputFile, "utf8"), {
      cwd: this.attach.cwd,
      roots: this.attach.roots,
    });
    return this.cached;
  }

  losses(): string[] {
    return [];
  }

  async status(): Promise<TracerStatus> {
    return { active: this.isAlive(), tracedDescendants: 0 };
  }

  async stop(): Promise<void> {
    if (this.isAlive()) this.child.kill("SIGKILL");
    await this.exit;
  }

  private isAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
}

describe.skipIf(!ENABLED)("linux real-strace smoke", () => {
  test("captures a representative installer through the shipped backend", async () => {
    const home = mkdtempSync(join(tmpdir(), "tret-smoke-"));
    const traceDir = mkdtempSync(join(tmpdir(), "tret-smoke-trace-"));
    const script = join(home, "install.sh");
    writeFileSync(join(home, "existing.txt"), "before\n");
    writeFileSync(join(home, "to-delete.txt"), "gone\n");
    writeFileSync(
      script,
      [
        "set -euo pipefail",
        'mkdir -p "$HOME/smoke/newdir"',
        'printf "created\\n" > "$HOME/smoke/newdir/created.txt"',
        'printf "after\\n" > "$HOME/existing.txt"',
        'ln -s target "$HOME/smoke/link"',
        'rm "$HOME/to-delete.txt"',
      ].join("\n"),
    );

    const roots = [home];
    const backups = { enabled: true, sizeLimitBytes: 1024 * 1024 };
    let tracer: ParentStraceTracer | undefined;
    const backend = new LinuxCaptureBackend({
      tracerFactory: async () => {
        tracer = new ParentStraceTracer({ roots, cwd: home, script }, traceDir);
        return tracer;
      },
      baseline: "capture",
      settleMs: 5000,
    });

    const session = await backend.start({ pid: process.pid, privilege: "user", roots, backups });
    await tracer?.wait();
    const journal = await session.stop();

    expect(journal.backend).toBe("linux-strace");
    expect(journal.completeness).toBe("complete");
    expect(journal.partialReason).toBeUndefined();
    const effects = normalizeJournal({
      journal,
      backups,
      caseSensitive: true,
      availableBeforeImages: new Set(journal.beforeImages?.keys() ?? []),
    });

    const owned = effects.owned.map((entry) => [entry.path, entry.kind]);
    expect(owned).toContainEqual([join(home, "smoke/newdir/created.txt"), "file"]);
    expect(owned).toContainEqual([join(home, "smoke/link"), "symlink"]);
    expect(effects.mutated.map((entry) => entry.path)).toContain(join(home, "existing.txt"));
    expect(effects.deleted.map((entry) => entry.path)).toContain(join(home, "to-delete.txt"));

    // With backups enabled the baseline read the pre-window bytes, so both the overwritten and the
    // deleted file carry a restorable before-image under their content address.
    const mutated = effects.mutated.find((entry) => entry.path === join(home, "existing.txt"))!;
    expect(mutated.beforeBlob).toBeDefined();
    expect(new TextDecoder().decode(journal.beforeImages!.get(mutated.beforeBlob!))).toBe("before\n");
    const deleted = effects.deleted.find((entry) => entry.path === join(home, "to-delete.txt"))!;
    expect(deleted.beforeBlob).toBeDefined();
    expect(new TextDecoder().decode(journal.beforeImages!.get(deleted.beforeBlob!))).toBe("gone\n");

    // Nothing outside the observe root may be attributed, even though strace saw the whole
    // installer tree (bash startup, dynamic linking) run outside it.
    for (const entry of [...effects.owned, ...effects.mutated, ...effects.deleted]) {
      expect(entry.path.startsWith(`${home}/`)).toBe(true);
    }
  }, 30_000);
});
