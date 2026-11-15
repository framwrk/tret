import { CaptureConsentError, prepareCapture } from "./preflight";
import { expect, test } from "bun:test";
import { FakeCaptureBackend } from "./fake";
import { runCaptureFallback } from "./fallback";

test.each([false, true])(
  "unexpected attach failure requires fresh weaker permission (accepted: %s)",
  async (allowWeakerCapture) => {
    const primary = new FakeCaptureBackend({ name: "linux-strace", completeness: "complete" });
    primary.start = async () => {
      throw new Error("unexpected attach failure");
    };
    const fallback = new FakeCaptureBackend({ name: "linux-heuristic", completeness: "heuristic" });
    const plan = await prepareCapture({
      primary,
      fallback,
      roots: ["/opt", "/fixture"],
      backups: { enabled: false, sizeLimitBytes: 1024 },
      allowWeakerCapture,
    });
    let runs = 0;
    const attempt = runCaptureFallback({
      primary: plan.backend!,
      fallback: plan.fallback,
      roots: plan.roots,
      fallbackRoots: ["/fixture"],
      pid: 1,
      privilege: "user",
      beforeFallback: plan.beforeFallback,
      beforeRun: async () => {
        expect(plan.roots).toEqual(["/fixture"]);
      },
      run: async () => {
        runs++;
        return 0;
      },
    });
    if (allowWeakerCapture) {
      expect((await attempt).usedFallback).toBe(true);
      expect(runs).toBe(1);
      expect(fallback.starts).toHaveLength(1);
    } else {
      await expect(attempt).rejects.toBeInstanceOf(CaptureConsentError);
      expect(runs).toBe(0);
      expect(fallback.starts).toHaveLength(0);
    }
  },
);
