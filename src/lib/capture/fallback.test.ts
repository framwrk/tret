import type { CaptureBackend, CaptureSession } from "./backend";
import { FakeCaptureBackend } from "./fake";
import { describe, expect, test } from "bun:test";
import { heuristicCaptureBackendFor } from "./current";
import { heuristicFallbackRoots, runCaptureFallback } from "./fallback";
import { LINUX_PLATFORM, MACOS_PLATFORM } from "../platform";

/** A backend that refuses to attach, like a tracer blocked by Yama `ptrace_scope=1`. */
class ThrowingStartBackend implements CaptureBackend {
  readonly completeness = "complete" as const;
  starts = 0;
  constructor(readonly name = "throw-start") {}

  async start(): Promise<CaptureSession> {
    this.starts += 1;
    throw new Error("strace could not attach: Operation not permitted");
  }
}

const SESSION = { pid: 1, privilege: "user" as const, roots: ["/tmp"] };

describe("runCaptureFallback", () => {
  test("an attach failure runs the observed work exactly once under the fallback", async () => {
    const primary = new ThrowingStartBackend("linux-strace");
    const fallback = new FakeCaptureBackend({ name: "linux-heuristic", completeness: "heuristic" });
    let runs = 0;

    const result = await runCaptureFallback({
      ...SESSION,
      primary,
      fallback,
      run: async () => {
        runs += 1;
        return 0;
      },
    });

    expect(primary.starts).toBe(1);
    expect(runs).toBe(1);
    expect(result.session).toBeDefined();
    expect(result.usedFallback).toBe(true);
    expect(result.session?.coverage.backend).toBe("linux-heuristic");
    expect(result.session?.coverage.completeness).toBe("heuristic");
  });

  test("both backends failing refuses before the observed work starts", async () => {
    const primary = new ThrowingStartBackend("linux-strace");
    const fallback = new ThrowingStartBackend("linux-heuristic");
    let runs = 0;

    const result = await runCaptureFallback({
      ...SESSION,
      primary,
      fallback,
      run: async () => {
        runs += 1;
        return 0;
      },
    });

    expect(primary.starts).toBe(1);
    expect(fallback.starts).toBe(1);
    expect(runs).toBe(0);
    expect(result.session).toBeUndefined();
    if (result.session !== undefined) throw new Error("expected both backends to refuse");
    expect(result.usedFallback).toBe(false);
    expect(String(result.primaryError)).toContain("could not attach");
    expect(String(result.fallbackError)).toContain("could not attach");
  });

  test("a primary that started and reports partial coverage is not re-run", async () => {
    const primary = new FakeCaptureBackend({
      name: "linux-fanotify",
      completeness: "partial",
      partialReason: "dropped a directory-entry event",
    });
    const fallback = new ThrowingStartBackend("linux-heuristic");
    let runs = 0;

    const result = await runCaptureFallback({
      ...SESSION,
      primary,
      fallback,
      run: async () => {
        runs += 1;
        return 0;
      },
    });

    expect(runs).toBe(1);
    expect(fallback.starts).toBe(0);
    expect(result.session?.coverage.backend).toBe("linux-fanotify");
    expect(result.session?.coverage.completeness).toBe("partial");
  });

  test("applies the narrowed roots to the fallback window only", async () => {
    const primary = new ThrowingStartBackend("linux-strace");
    const fallback = new FakeCaptureBackend({ name: "linux-heuristic", completeness: "heuristic" });
    const roots = ["/opt", "/usr/bin", "/usr/local/bin"];
    const fallbackRoots = heuristicFallbackRoots(roots);

    await runCaptureFallback({ ...SESSION, primary, fallback, roots, fallbackRoots, run: async () => 0 });

    expect(fallback.starts[0]?.roots).toEqual(["/usr/local/bin"]);
  });
});

describe("heuristic fallback name", () => {
  test("Linux names the fallback linux-heuristic and macOS keeps macos-heuristic", () => {
    const linux = heuristicCaptureBackendFor(LINUX_PLATFORM, true);
    const macos = heuristicCaptureBackendFor(MACOS_PLATFORM, true);

    expect(linux.name).toBe("linux-heuristic");
    expect(linux.completeness).toBe("heuristic");
    expect(macos.name).toBe("macos-heuristic");
    expect(macos.completeness).toBe("heuristic");
  });
});
