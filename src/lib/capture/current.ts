import type { CaptureBackend } from "./backend";
import { LinuxCaptureBackend } from "./linux";
import { MACOS_HEURISTIC_BACKEND, MacosHeuristicCaptureBackend } from "./macos";
import type { Platform } from "../platform";

/** Identifier stored in `record.capture.backend` for the Linux heuristic fallback (F6.4). */
export const LINUX_HEURISTIC_BACKEND = "linux-heuristic";

/**
 * The labeled scoped-snapshot backend used when a platform's first-choice tracer cannot attach
 * before the observed work starts. It never claims process attribution; only its display name
 * differs by platform (`linux-heuristic` on Linux, `macos-heuristic` on macOS), while the journal
 * and record completeness value stays `heuristic`.
 */
export function heuristicCaptureBackendFor(platform: Platform, caseSensitive?: boolean): MacosHeuristicCaptureBackend {
  return new MacosHeuristicCaptureBackend({
    name: platform.id === "linux" ? LINUX_HEURISTIC_BACKEND : MACOS_HEURISTIC_BACKEND,
    caseSensitive: caseSensitive ?? platform.case.defaultCaseSensitive,
  });
}

/**
 * Selects the capture backend for a platform (plan section 8). Linux gets the first-class tracer;
 * macOS gets the labeled heuristic fallback (D1/D7). Both produce the same `CaptureBackend` journal,
 * so the session and record code never branch on the OS. `caseSensitive` is the probed record-wide
 * case flag (D10); the fallback compares paths with it so its keys match journal normalization.
 */
export function captureBackendFor(platform: Platform, caseSensitive?: boolean): CaptureBackend {
  switch (platform.id) {
    case "linux":
      return new LinuxCaptureBackend();
    case "darwin":
      return heuristicCaptureBackendFor(platform, caseSensitive);
  }
}
