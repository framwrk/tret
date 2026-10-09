import type { CaptureBackend, CaptureSession, CaptureStartOptions } from "./backend";
import type { Journal, JournalEvent, JournalEventInput } from "./events";
import type { CaptureCompleteness } from "../../types";

export type FakeCaptureBackendOptions = {
  name?: string;
  completeness?: CaptureCompleteness;
  partialReason?: string;
};

/**
 * In-memory `CaptureBackend` for tests: queue events, then `start`/`stop` to collect a journal.
 * It performs no filesystem work, so record normalization can be exercised without a real tracer.
 */
export class FakeCaptureBackend implements CaptureBackend {
  readonly name: string;
  readonly completeness: CaptureCompleteness;
  /** Every `start()` call, so tests can assert what the backend was asked to observe. */
  readonly starts: CaptureStartOptions[] = [];
  private readonly partialReason?: string;
  private readonly queued: JournalEvent[] = [];
  private nextSeq = 0;

  constructor(options: FakeCaptureBackendOptions = {}) {
    this.name = options.name ?? "fake";
    this.completeness = options.completeness ?? "complete";
    this.partialReason = options.partialReason;
  }

  /** Queues an event without `seq`/`at`, which the journal assigns when it is built. */
  push(event: JournalEventInput): void {
    this.queued.push({ ...event, seq: this.nextSeq++, at: Date.now() } as JournalEvent);
  }

  async start(options: CaptureStartOptions): Promise<CaptureSession> {
    this.starts.push(options);
    return {
      backend: this.name,
      stop: async (): Promise<Journal> => ({
        backend: this.name,
        completeness: this.completeness,
        partialReason: this.partialReason,
        events: this.queued.slice(),
      }),
    };
  }
}
