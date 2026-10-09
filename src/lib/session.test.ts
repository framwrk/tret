import type { CaptureBackend, CaptureSession } from "./capture/backend";
import { buildCaptureSegment, formatCoverage, formatWindow, runBoundedSession } from "./session";
import { describe, expect, test } from "bun:test";
import { installObservationRoots, observationRoots } from "./platform";
import { FakeCaptureBackend } from "./capture/fake";
import type { Journal } from "./capture/events";
import { LINUX_PLATFORM } from "./platform";
import { MACOS_PLATFORM } from "./platform";
import type { RecordV3 } from "../types";
import { captureBackendFor } from "./capture/current";
import { isV3Record } from "./records";

const HASH = "a".repeat(64);

function completeJournal(overrides: Partial<Journal> = {}): Journal {
  return { backend: "fake", completeness: "complete", events: [], ...overrides };
}

/** A backend whose `start` always fails, to prove the work never runs unwatched. */
class ThrowingStartBackend implements CaptureBackend {
  readonly name = "throw-start";
  readonly completeness = "complete" as const;
  async start(): Promise<CaptureSession> {
    throw new Error("cannot attach");
  }
}

/** A backend whose `stop` always fails, to prove a failed close is partial coverage, not a crash. */
class ThrowingStopBackend implements CaptureBackend {
  readonly name = "throw-stop";
  readonly completeness = "complete" as const;
  async start(): Promise<CaptureSession> {
    return {
      backend: this.name,
      stop: async (): Promise<Journal> => {
        throw new Error("cannot close");
      },
    };
  }
}

/** A backend that records whether its window was closed, so a throwing work item still closes it. */
class ClosingBackend implements CaptureBackend {
  readonly name = "closing";
  readonly completeness = "complete" as const;
  stopCalls = 0;
  async start(): Promise<CaptureSession> {
    return {
      backend: this.name,
      stop: async (): Promise<Journal> => {
        this.stopCalls += 1;
        return completeJournal({ backend: this.name });
      },
    };
  }
}

describe("runBoundedSession", () => {
  test("attaches capture before the work, returns its value, and reports the journal", async () => {
    const backend = new FakeCaptureBackend();
    backend.push({ type: "create", path: "/tmp/tool", after: { kind: "file", hash: HASH } });

    let attachedBeforeRun = false;
    const result = await runBoundedSession({
      backend,
      pid: 4242,
      privilege: "user",
      roots: ["/tmp"],
      run: async () => {
        attachedBeforeRun = backend.starts.length === 1;
        return 7;
      },
    });

    expect(attachedBeforeRun).toBe(true);
    expect(result.value).toBe(7);
    expect(result.error).toBeUndefined();
    expect(result.journal.events).toHaveLength(1);
    expect(result.coverage.backend).toBe("fake");
    expect(result.coverage.completeness).toBe("complete");
    expect(result.coverage.events).toBe(1);
    expect(result.coverage.roots).toEqual(["/tmp"]);
    expect(result.coverage.segment.partialReason).toBeUndefined();
    expect(backend.starts).toEqual([{ pid: 4242, privilege: "user", roots: ["/tmp"] }]);
  });

  test("stamps the window from the injected clock and formats its duration", async () => {
    let now = 1_000;
    const backend = new FakeCaptureBackend();

    const result = await runBoundedSession({
      backend,
      pid: 1,
      privilege: "user",
      roots: ["/tmp"],
      now: () => now,
      run: async () => {
        now = 3_500;
        return 0;
      },
    });

    expect(result.coverage.segment.startedAt).toBe(new Date(1_000).toISOString());
    expect(result.coverage.segment.endedAt).toBe(new Date(3_500).toISOString());
    expect(result.coverage.segment.kind).toBe("install");
    expect(formatWindow(result.coverage.segment)).toBe(
      `${new Date(1_000).toISOString()} → ${new Date(3_500).toISOString()} (2.5s)`,
    );
  });

  test("records an incomplete window as a partial segment with a reason", async () => {
    const backend = new FakeCaptureBackend({ completeness: "partial", partialReason: "lost a tracee at the uid transition" });

    const result = await runBoundedSession({ backend, pid: 1, privilege: "root", roots: [], run: async () => 0 });

    expect(result.coverage.completeness).toBe("partial");
    expect(result.coverage.segment.partialReason).toBe("lost a tracee at the uid transition");
    expect(formatCoverage(result.coverage)).toContain("partial: lost a tracee at the uid transition");
    expect(formatCoverage(result.coverage)).toContain("0 events over 0 roots");
  });

  test("labels heuristic capture as having no process tree", async () => {
    const backend = new FakeCaptureBackend({ completeness: "heuristic" });

    const result = await runBoundedSession({ backend, pid: 1, privilege: "user", roots: ["/tmp"], run: async () => 0 });

    expect(result.coverage.segment.partialReason).toBe("capture reported incomplete attribution");
    expect(formatCoverage(result.coverage)).toContain("heuristic attribution, no process tree");
  });

  test("closes the window even when the observed work throws", async () => {
    const backend = new ClosingBackend();
    const boom = new Error("work failed");

    const result = await runBoundedSession({
      backend,
      pid: 1,
      privilege: "user",
      roots: ["/tmp"],
      run: async () => {
        throw boom;
      },
    });

    expect(result.error).toBe(boom);
    expect(result.value).toBeUndefined();
    expect(backend.stopCalls).toBe(1);
  });

  test("does not run the work when capture cannot attach", async () => {
    const backend = new ThrowingStartBackend();
    let ran = false;

    await expect(
      runBoundedSession({
        backend,
        pid: 1,
        privilege: "user",
        roots: ["/tmp"],
        run: async () => {
          ran = true;
          return 1;
        },
      }),
    ).rejects.toThrow("cannot attach");
    expect(ran).toBe(false);
  });

  test("reports a failed close as partial coverage instead of throwing, keeping the work result", async () => {
    const backend = new ThrowingStopBackend();

    const result = await runBoundedSession({ backend, pid: 1, privilege: "user", roots: ["/tmp"], run: async () => 5 });

    expect(result.value).toBe(5);
    expect(result.error).toBeUndefined();
    expect(result.journal.completeness).toBe("partial");
    expect(result.coverage.partialReason).toContain("cannot close");
    expect(result.coverage.events).toBe(0);
  });
});

describe("buildCaptureSegment", () => {
  test("omits partialReason for a complete window", () => {
    const segment = buildCaptureSegment({
      kind: "install",
      startedAt: "2026-10-09T00:00:00.000Z",
      endedAt: "2026-10-09T00:00:01.000Z",
      journal: completeJournal(),
    });

    expect(segment).toEqual({
      kind: "install",
      startedAt: "2026-10-09T00:00:00.000Z",
      endedAt: "2026-10-09T00:00:01.000Z",
    });
  });

  test("defaults a reason for incomplete capture reported without one", () => {
    const segment = buildCaptureSegment({
      kind: "install",
      startedAt: "2026-10-09T00:00:00.000Z",
      endedAt: "2026-10-09T00:00:01.000Z",
      journal: completeJournal({ completeness: "partial" }),
    });

    expect(segment.partialReason).toBe("capture reported incomplete attribution");
  });

  test("reserves a trace segment in a v3 record without a format migration (D5)", () => {
    const install = buildCaptureSegment({
      kind: "install",
      startedAt: "2026-10-09T00:00:00.000Z",
      endedAt: "2026-10-09T00:00:01.000Z",
      journal: completeJournal(),
    });
    const trace = buildCaptureSegment({
      kind: "trace",
      startedAt: "2026-10-09T01:00:00.000Z",
      endedAt: "2026-10-09T01:00:02.000Z",
      journal: completeJournal({ backend: "linux-strace" }),
    });

    const record: RecordV3 = {
      id: "record-1",
      name: "tool",
      source: "install",
      url: "https://example.com/install.sh",
      installedAt: install.startedAt,
      executable: "/usr/local/bin/tool",
      scriptSha256: HASH,
      capture: { backend: "fake", completeness: "complete", segments: [install, trace] },
      privilege: "user",
      caseSensitive: true,
      owned: [],
      mutated: [],
      deleted: [],
    };

    expect(isV3Record(record)).toBe(true);
    expect(record.capture.segments.map((segment) => segment.kind)).toEqual(["install", "trace"]);
  });
});

describe("captureBackendFor", () => {
  test("selects the tracer on Linux and the heuristic fallback on macOS", () => {
    expect(captureBackendFor(LINUX_PLATFORM).name).toBe("linux-strace");
    expect(captureBackendFor(LINUX_PLATFORM).completeness).toBe("complete");
    expect(captureBackendFor(MACOS_PLATFORM).name).toBe("macos-heuristic");
    expect(captureBackendFor(MACOS_PLATFORM).completeness).toBe("heuristic");
  });
});

describe("observation roots", () => {
  test("expand a platform table into sorted, home-relative roots (D3)", () => {
    const roots = observationRoots(MACOS_PLATFORM, { home: "/Users/tester" });

    expect(roots).toContain("/opt/homebrew/bin");
    expect(roots).toContain("/Users/tester/.config");
    expect(roots).toContain("/Users/tester/.zshrc");
    expect(roots).toEqual([...roots].sort());
  });

  test("drop shared cache directories from an install window scope", () => {
    const roots = installObservationRoots(MACOS_PLATFORM, { home: "/Users/tester" });

    expect(roots).toContain("/Users/tester/.config");
    expect(roots).not.toContain("/Users/tester/.cache");
  });
});
