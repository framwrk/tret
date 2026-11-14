import { expect, test } from "bun:test";
import { BeforeExecutionError } from "./session";
import type { CaptureBackend } from "./capture/backend";
import { runCaptureFallback } from "./capture/fallback";

test.each([false, true])(
  "a persistence barrier failure stops capture and never falls back or executes (fallback already selected: %s)",
  async (fallbackSelected) => {
    let runs = 0;
    let starts = 0;
    let stops = 0;
    const backend: CaptureBackend = {
      name: "fixture",
      completeness: "heuristic",
      start: async () => {
        starts++;
        return {
          backend: "fixture",
          stop: async () => {
            stops++;
            return { backend: "fixture", completeness: "heuristic", events: [] };
          },
        };
      },
    };
    const failing: CaptureBackend = {
      ...backend,
      start: async () => {
        throw new Error("attach failed before run");
      },
    };
    await expect(
      runCaptureFallback({
        primary: fallbackSelected ? failing : backend,
        fallback: backend,
        pid: process.pid,
        privilege: "user",
        roots: [],
        beforeRun: async () => {
          throw new Error("disk full before intent flush");
        },
        run: async () => {
          runs++;
          return 0;
        },
      }),
    ).rejects.toBeInstanceOf(BeforeExecutionError);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(runs).toBe(0);
  },
);
