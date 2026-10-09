import type { LinuxTracer, TracerStatus } from "./tracer";
import type { TracerRecord, TracerResult } from "./raw";

/**
 * In-memory `LinuxTracer` for backend tests: queue tracer records, declare loss reasons, and control
 * whether the tracer is still attached at stop. It performs no tracing, so completeness logic and
 * reconstruction can be exercised deterministically on any host.
 */
export class FakeLinuxTracer implements LinuxTracer {
  readonly name: string;
  readonly attached: { pid: number; roots: string[] };
  private recordsOut: TracerRecord[] = [];
  private diagnosticLines: string[] = [];
  private readonly lossReasons: string[] = [];
  private active: boolean;

  constructor(options: { name?: string; pid?: number; roots?: string[]; active?: boolean } = {}) {
    this.name = options.name ?? "fake-linux";
    this.attached = { pid: options.pid ?? 1, roots: options.roots ?? [] };
    this.active = options.active ?? false;
  }

  push(record: TracerRecord): this {
    this.recordsOut.push(record);
    return this;
  }

  diagnose(line: string): this {
    this.diagnosticLines.push(line);
    return this;
  }

  addLoss(reason: string): this {
    this.lossReasons.push(reason);
    return this;
  }

  setActive(active: boolean): this {
    this.active = active;
    return this;
  }

  async records(): Promise<TracerResult> {
    const unsupported = this.recordsOut.filter((record) => record.op === "unsupported").map((record) => record.syscall);
    return {
      records: this.recordsOut.slice(),
      unsupported: [...new Set(unsupported)].sort(),
      diagnostics: this.diagnosticLines.slice(),
    };
  }

  losses(): string[] {
    return this.lossReasons.slice();
  }

  async status(): Promise<TracerStatus> {
    return { active: this.active, tracedDescendants: 0 };
  }

  async stop(): Promise<void> {
    this.active = false;
  }
}
