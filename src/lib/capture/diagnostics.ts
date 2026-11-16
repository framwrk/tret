import type { NormalizationDiagnostic, NormalizedEffects } from "./normalize";

export type CaptureDiagnostics = { entries: NormalizationDiagnostic[]; omitted: number };
const MAX_ENTRIES = 32;
const MAX_BYTES = 64 * 1024;
const CODES = ["temp-rename", "create-delete", "rename", "coverage", "unsupported"];

function validEntry(value: unknown): value is NormalizationDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<NormalizationDiagnostic>;
  return (
    CODES.includes(String(entry.code)) &&
    typeof entry.message === "string" &&
    entry.message.length > 0 &&
    Buffer.byteLength(entry.message) <= 1024 &&
    Array.isArray(entry.paths) &&
    entry.paths.length <= 2 &&
    entry.paths.every(
      (path) => typeof path === "string" && path.startsWith("/") && !path.includes("\0") && Buffer.byteLength(path) <= 4096,
    )
  );
}

export function validCaptureDiagnostics(value: unknown): value is CaptureDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<CaptureDiagnostics>;
  return (
    Array.isArray(report.entries) &&
    report.entries.length <= MAX_ENTRIES &&
    report.entries.every(validEntry) &&
    Number.isSafeInteger(report.omitted) &&
    report.omitted! >= 0 &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES
  );
}

/** Bound collection itself; omitted notes never change effect classification or cleanup authority. */
export class DiagnosticCollector {
  private readonly entries: NormalizationDiagnostic[] = [];
  private omitted = 0;

  push(entry: NormalizationDiagnostic): void {
    // Reserve enough envelope space even if the final omitted count grows after this entry.
    if (
      this.entries.length >= MAX_ENTRIES ||
      !validEntry(entry) ||
      Buffer.byteLength(
        JSON.stringify({
          entries: [...this.entries, entry],
          omitted: Number.MAX_SAFE_INTEGER,
        }),
      ) > MAX_BYTES
    ) {
      this.omitted++;
      return;
    }
    this.entries.push(entry);
  }

  report(): CaptureDiagnostics {
    return { entries: this.entries, omitted: this.omitted };
  }
}

export function normalizationDetails(effects: NormalizedEffects): { normalization?: CaptureDiagnostics } {
  return effects.diagnostics.length || effects.diagnosticsOmitted
    ? {
        normalization: { entries: effects.diagnostics, omitted: effects.diagnosticsOmitted ?? 0 },
      }
    : {};
}
