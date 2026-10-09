import type { CaptureBackend } from "./backend";
import { LinuxCaptureBackend } from "./linux";
import { MacosHeuristicCaptureBackend } from "./macos";
import type { Platform } from "../platform";

/**
 * Selects the capture backend for a platform (plan section 8). Linux gets the first-class tracer; macOS
 * gets the labeled heuristic fallback (D1/D7). Both produce the same `CaptureBackend` journal, so the
 * session and record code never branch on the OS.
 */
export function captureBackendFor(platform: Platform): CaptureBackend {
  switch (platform.id) {
    case "linux":
      return new LinuxCaptureBackend();
    case "darwin":
      return new MacosHeuristicCaptureBackend({ caseSensitive: platform.case.defaultCaseSensitive });
  }
}
